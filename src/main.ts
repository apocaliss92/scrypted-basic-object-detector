import sdk, { MixinDeviceBase, MixinProvider, ObjectDetection, ObjectDetectionModel, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, SettingValue, Settings, VideoCamera, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ObjectDetectionMixin } from './objectDetectionMixin';

const fpsKillWaterMark = 5
const fpsLowWaterMark = 7;
const lowPerformanceMinThreshold = 2;

interface ObjectDetectionStatistics {
  dps: number;
  sampleTime: number;
}

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById('@scrypted/nvr', 'motion')?.id;
export const nvrObjectDetertorId = sdk.systemManager.getDeviceByName('Scrypted NVR Object Detection')?.id;

export class ObjectDetectionPlugin extends ScryptedDeviceBase implements Settings {
  currentMixins = new Set<ObjectDetectionMixin>();
  objectDetectionStatistics = new Map<number, ObjectDetectionStatistics>();
  statsSnapshotTime: number;
  statsSnapshotDetections: number;
  statsSnapshotConcurrent = 0;
  storageSettings = new StorageSettings(this, {
    objectDetectionDevice: {
      title: 'Object Detector',
      description: 'Select the object detection plugin to use for detecting objects.',
      type: 'device',
      deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}' && id !== '${nvrObjectDetertorId}'`,
      immediate: true,
    },
    activeObjectDetections: {
      title: 'Active Object Detection Sessions',
      multiple: true,
      readonly: true,
      onGet: async () => {
        const objectDetections = [...this.currentMixins.values()]
        const choices = objectDetections.map(dd => dd.name);
        const value = objectDetections.filter(c => c.detectorRunning).map(dd => dd.name);
        return {
          choices,
          value,
        }
      },
      mapGet: () => {
        const motion = [...this.currentMixins.values()];
        const value = motion.filter(c => c.detectorRunning).map(dd => dd.name);
        return value;
      },
    },
  });
  devices = new Map<string, any>();

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId);

    // on an interval check to see if system load allows squelched detectors to start up.
    setInterval(() => {
      const runningDetections = this.runningObjectDetections;

      // don't allow too many cams to start up at once if resuming from a low performance state.
      let allowStart = 2;

      // allow minimum amount of concurrent cameras regardless of system specs
      if (runningDetections.length > lowPerformanceMinThreshold) {
        // if anything is below the kill threshold, do not start
        const killable = runningDetections.filter(o => o.detectionFps < fpsKillWaterMark && !o.analyzeStop);
        if (killable.length > lowPerformanceMinThreshold) {
          const cameraNames = runningDetections.map(o => `${o.name} ${o.detectionFps}`).join(', ');
          const first = killable[0];
          first.console.warn(`System at capacity. Ending object detection.`, cameraNames);
          first.endObjectDetection();

          this.console.log(`Killing ${killable[0]?.name}`);
          return;
        }

        const lowWatermark = runningDetections.filter(o => o.detectionFps < fpsLowWaterMark);
        if (lowWatermark.length > lowPerformanceMinThreshold)
          allowStart = 1;
      }

      const idleDetectors = [...this.currentMixins.values()].filter(dd => !dd.detectorRunning);

      // this.console.log(`Interval stats: ${JSON.stringify({
      //   idleDetectors: idleDetectors.map(idle => idle.name),
      //   allowStart
      // })}`);

      for (const notRunning of idleDetectors) {
        if (notRunning.maybeStartDetection()) {
          allowStart--;
          if (allowStart <= 0)
            return;
        }
      }
    }, 5000);
  }

  pruneOldStatistics() {
    const now = Date.now();
    for (const [k, v] of this.objectDetectionStatistics.entries()) {
      // purge the stats every hour
      if (Date.now() - v.sampleTime > 60 * 60 * 1000)
        this.objectDetectionStatistics.delete(k);
    }
  }

  trackDetection() {
    this.statsSnapshotDetections++;
  }

  canStartObjectDetection(mixin: ObjectDetectionMixin) {
    const runningDetections = this.runningObjectDetections;
    const lowWatermark = runningDetections.filter(o => o.detectionFps < fpsLowWaterMark);

    // this.console.log(`In canStartObjectDetection: ${JSON.stringify({
    //   runningDetections: runningDetections.map(elem => elem.name),
    //   lowPerformanceMinThreshold,
    //   lowWatermark: lowWatermark.length,
    //   fpsLowWaterMark,
    // })}`);

    // already running
    if (runningDetections.find(o => o.id === mixin.id))
      return false;

    // allow minimum amount of concurrent cameras regardless of system specs
    if (runningDetections.length < lowPerformanceMinThreshold)
      return true;

    // find any cameras struggling with a with low detection fps.
    // const lowWatermark = runningDetections.filter(o => o.detectionFps < fpsLowWaterMark);
    if (lowWatermark.length > lowPerformanceMinThreshold) {
      const [first] = lowWatermark;
      // if cameras have been detecting enough to catch the activity, kill it for new camera.
      const cameraNames = runningDetections.map(o => `${o.name} ${o.detectionFps}`).join(', ');
      if (Date.now() - first.detectionStartTime > 30000) {
        first.console.warn(`System at capacity. Ending object detection to process activity on ${mixin.name}.`, cameraNames);
        first.endObjectDetection();
        mixin.console.warn(`System at capacity. Ending object detection on ${first.name} to process activity.`, cameraNames);
        return true;
      }

      mixin.console.warn(`System at capacity. Not starting object detection to continue processing recent activity on ${first.name}.`, cameraNames);
      return false;
    }

    // System capacity is fine. Start the detection.
    return true;
  }

  get runningObjectDetections() {
    const runningDetections = [...this.currentMixins.values()]
      .filter(dd => dd.detectorRunning)
      .sort((a, b) => a.detectionStartTime - b.detectionStartTime);
    return runningDetections;
  }

  objectDetectionStarted(name: string, console: Console) {
    this.resetStats(console);

    this.statsSnapshotConcurrent++;
  }

  objectDetectionEnded(console: Console) {
    this.resetStats(console);

    this.statsSnapshotConcurrent--;
  }

  resetStats(console: Console) {
    const now = Date.now();
    const concurrentSessions = this.statsSnapshotConcurrent;
    if (concurrentSessions) {
      const duration = now - this.statsSnapshotTime;
      const stats: ObjectDetectionStatistics = {
        sampleTime: now,
        dps: this.statsSnapshotDetections / (duration / 1000),
      };

      // ignore short sessions and sessions with no detections (busted?).
      if (duration > 10000 && this.statsSnapshotDetections)
        this.objectDetectionStatistics.set(concurrentSessions, stats);

      this.pruneOldStatistics();

      const str = `video analysis, ${concurrentSessions} camera(s), dps: ${Math.round(stats.dps * 10) / 10} (${this.statsSnapshotDetections}/${Math.round(duration / 1000)})`;
      this.console.log(str);
      console?.log(str);
    }

    this.statsSnapshotDetections = 0;
    this.statsSnapshotTime = now;
  }

  getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
    if (
      (
        type === ScryptedDeviceType.Camera ||
        type === ScryptedDeviceType.Doorbell
      ) &&
      (
        interfaces.includes(ScryptedInterface.VideoCamera) ||
        interfaces.includes(ScryptedInterface.Camera)
      )
    ) {
      const ret: string[] = [
        ScryptedInterface.ObjectDetector,
        ScryptedInterface.Settings,
      ];
      // const model = await this.mixinDevice.getDetectionModel();

      // if (model.classes?.includes('motion')) {
      //   ret.push(
      //     ScryptedInterface.MotionSensor,
      //   );
      // }

      return ret;
    }
  }

  async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState) {
    try {
      const objectDetection = this.storageSettings.values.objectDetectionDevice;
      if (!objectDetection) {
        return;
      }
      const model = await objectDetection.getDetectionModel();

      const ret = new ObjectDetectionMixin(
        this,
        mixinDevice,
        mixinDeviceInterfaces,
        mixinDeviceState,
        this.nativeId,
        objectDetection,
        model,
        'Basic object detection',
      );

      this.currentMixins.add(ret);
      return ret;
    } catch (e) {
      this.console.log('Error on getMixin', e);
    }
  }

  async releaseMixin(id: string, mixinDevice: ObjectDetectionMixin) {
    this.currentMixins.delete(mixinDevice);
    return mixinDevice?.release();
  }
}

export default ObjectDetectionPlugin;
