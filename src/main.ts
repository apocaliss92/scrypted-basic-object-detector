import sdk, { MediaObject, ObjectDetection, ObjectDetectionGenerator, ObjectDetectionGeneratorResult, ObjectDetectionGeneratorSession, ObjectDetectionModel, ObjectDetectionSession, ObjectsDetected, ScryptedDeviceBase, ScryptedNativeId, Setting, Settings, SettingValue, VideoFrame } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ObjectTracker } from './objectTracker';
import { getClassnameSettings, prefilterDetections } from './util';

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

  getObjectDetector(): ObjectDetection {
    return this.storageSettings.values.objectDetectionDevice;
  }

  public getLogger(session: ObjectDetectionGeneratorSession) {
    const deviceConsole = sdk.deviceManager.getMixinConsole(session.sourceId, this.nativeId);

    const debug = JSON.parse(session.settings.debug || 'false');
    const info = JSON.parse(session.settings.info || 'false');

    const log = (type: 'log' | 'error' | 'debug' | 'warn' | 'info', message?: any, ...optionalParams: any[]) => {
      const now = new Date().toLocaleString();

      let canLog = false;
      if (type === 'debug') {
        canLog = debug;
      } else if (type === 'info') {
        canLog = info;
      } else {
        canLog = true;
      }

      if (canLog) {
        deviceConsole.log(` ${now} - `, message, ...optionalParams);
      }
    };

    return {
      log: (message?: any, ...optionalParams: any[]) => log('log', message, ...optionalParams),
      info: (message?: any, ...optionalParams: any[]) => log('info', message, ...optionalParams),
      debug: (message?: any, ...optionalParams: any[]) => log('debug', message, ...optionalParams),
      error: (message?: any, ...optionalParams: any[]) => log('error', message, ...optionalParams),
      warn: (message?: any, ...optionalParams: any[]) => log('warn', message, ...optionalParams),
    } as Console

  }

  async generateObjectDetections(videoFrames: AsyncGenerator<VideoFrame, void> | MediaObject, session: ObjectDetectionGeneratorSession): Promise<AsyncGenerator<ObjectDetectionGeneratorResult, void>> {
    const objectDetection = this.getObjectDetector();
    const logger = this.getLogger(session);

    if (!objectDetection) {
      throw new Error('Object detector unavailable');
    }

    const originalGen = await objectDetection.generateObjectDetections(videoFrames, session);
    const objectTracker = new ObjectTracker({ logger, session });

    const transformedGen = async function* () {
      for await (const detectionResult of originalGen) {
        const now = Date.now();
        detectionResult.detected.timestamp = now;
        logger.debug(`Detections incoming: ${JSON.stringify(detectionResult)}`);

        const { active, pending, detectionId } = objectTracker.update(detectionResult.detected.detections);
        logger.debug(`Detections processed: ${JSON.stringify({ active, pending, detectionId })}`);

        detectionResult.detected.detections = active;
        detectionResult.detected.detectionId = detectionId;

        yield detectionResult;
      }
    }.bind(this);

    return transformedGen();
  }

  async detectObjects(mediaObject: MediaObject, session?: ObjectDetectionSession): Promise<ObjectsDetected> {
    const objectDetection = this.getObjectDetector();

    if (!objectDetection) {
      throw new Error('Object detector unavailable');
    }

    const res = await objectDetection.detectObjects(mediaObject, session);
    res.detections = prefilterDetections({
      detections: res.detections,
      settings: session?.settings,
    });
    return res;
  }

  async getDetectionModel(settings?: { [key: string]: any; }): Promise<ObjectDetectionModel> {
    const objectDetection = this.getObjectDetector();

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
        const { minConfirmationFramesSetting, minScoreSetting, iouThresholdSetting, movementThresholdSetting } = getClassnameSettings(classname);
        model.settings.push(
          {
            key: minScoreSetting,
            title: `Minimum score`,
            type: 'number',
            subgroup: classname,
            value: 0.7
          },
          {
            key: minConfirmationFramesSetting,
            title: `Minimum confirmation frames`,
            type: 'number',
            subgroup: classname,
            value: 3
          },
          {
            key: iouThresholdSetting,
            title: `IoU threshold`,
            type: 'number',
            subgroup: classname,
            value: 0.5
          },
          {
            key: movementThresholdSetting,
            title: `Movement threshold`,
            type: 'number',
            subgroup: classname,
            value: 10
          }
        );
      }

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

    model.settings.push(
      {
        key: 'debug',
        title: 'Log debug messages',
        type: 'boolean',
        value: false,
        immediate: true,
      },
      {
        key: 'info',
        title: 'Log info messages',
        type: 'boolean',
        value: false,
        immediate: true,
      }
    );

    return model;
  }
}

export default ObjectDetectionPlugin;

