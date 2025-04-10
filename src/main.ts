import sdk, { MediaObject, ObjectDetection, ObjectDetectionGenerator, ObjectDetectionGeneratorResult, ObjectDetectionGeneratorSession, ObjectDetectionModel, ObjectDetectionResult, ObjectDetectionSession, ObjectsDetected, ScryptedDeviceBase, ScryptedNativeId, Setting, Settings, SettingValue, VideoFrame } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ObjectTracker } from './objectTracker';

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById('@scrypted/nvr', 'motion')?.id;
export const nvrObjectDetertorId = sdk.systemManager.getDeviceByName('Scrypted NVR Object Detection')?.id;

export class ObjectDetectionPlugin extends ScryptedDeviceBase implements ObjectDetection, Settings, ObjectDetectionGenerator {
  storageSettings = new StorageSettings(this, {
    objectDetectionDevice: {
      title: 'Object Detector',
      description: 'Select the object detection plugin to use for detecting objects.',
      type: 'device',
      deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}' && id !== '${nvrObjectDetertorId}' && id !== '${this.id}'`,
      immediate: true,
      onPut: async () => sdk.deviceManager.requestRestart()
    },
  });

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId);
  }

  getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  filterBySettings(detections: ObjectDetectionResult[], settings?: any) {
    if (!detections || detections.length === 0) return [];

    if (!settings) {
      return detections;
    }

    const enabledClasses = settings?.enabledClasses;
    return detections.filter(det => {
      const className = det.className;
      if (!enabledClasses.includes(className)) {
        return false;
      }

      const scoreThreshold = settings[`${className}-minScore`] || 0.7;

      if (det.score < scoreThreshold) {
        return false
      }

      return true;
    })
  }

  async generateObjectDetections(videoFrames: AsyncGenerator<VideoFrame, void> | MediaObject, session: ObjectDetectionGeneratorSession): Promise<AsyncGenerator<ObjectDetectionGeneratorResult, void>> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    const logger = sdk.deviceManager.getMixinConsole(session.sourceId, this.nativeId);

    if (!objectDetection) {
      throw new Error('Object detector unavailable');
    }

    const originalGen = await objectDetection.generateObjectDetections(videoFrames, session);
    const objectTracker = new ObjectTracker({ logger, session });

    const transformedGen = async function* () {
      for await (const detectParent of originalGen) {
        const detectionResult = detectParent as ObjectDetectionGeneratorResult;
        const now = Date.now();
        detectionResult.detected.timestamp = now;

        detectionResult.detected.detections = this.filterBySettings(detectionResult.detected.detections, session.settings);
        const { active, detectionId } = objectTracker.update(detectionResult.detected.detections);
        logger.log(JSON.stringify({ active, detectionId }));

        detectionResult.detected.detections = active;
        detectionResult.detected.detectionId = detectionId;

        yield detectionResult;
      }
    }.bind(this);

    return transformedGen();
  }

  async detectObjects(mediaObject: MediaObject, session?: ObjectDetectionSession): Promise<ObjectsDetected> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    if (!objectDetection) {
      throw new Error('Object detector unavailable');
    }
    const res = await objectDetection.detectObjects(mediaObject, session);
    // res.detected = this.applyDetectionsFilters(res.detected, session);
    return res;
  }

  async getDetectionModel(settings?: { [key: string]: any; }): Promise<ObjectDetectionModel> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    if (!objectDetection) {
      throw new Error('Object detector unavailable');
    }

    const model = await objectDetection.getDetectionModel(settings);

    if (model.settings) model.settings = [];
    const classnames = model.classes;

    if (classnames) {
      model.settings.push({
        key: 'enabledClasses',
        title: 'Detection classes',
        description: 'Detection classes to enable',
        multiple: true,
        choices: classnames,
        combobox: true,
        value: classnames
      } as Setting);

      for (const classname of classnames) {
        model.settings.push({
          key: `${classname}-minScore`,
          title: `${classname} minimum score`,
          type: 'number',
          subgroup: 'Advanced',
          value: 0.7
        } as Setting);
      }
    }

    return model;
  }
}

export default ObjectDetectionPlugin;

