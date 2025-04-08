import sdk, { MediaObject, ObjectDetection, ObjectDetectionGenerator, ObjectDetectionGeneratorResult, ObjectDetectionGeneratorSession, ObjectDetectionModel, ObjectDetectionResult, ObjectDetectionSession, ObjectsDetected, ScryptedDeviceBase, ScryptedNativeId, Setting, SettingValue, Settings, VideoFrame } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import cloneDeep from 'lodash/cloneDeep';
import { analyzeMovement, filterBySettings, filterOverlappedDetections } from './util';

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById('@scrypted/nvr', 'motion')?.id;
export const nvrObjectDetertorId = sdk.systemManager.getDeviceByName('Scrypted NVR Object Detection')?.id;

export class ObjectDetectionPlugin extends ScryptedDeviceBase implements ObjectDetection, Settings, ObjectDetectionGenerator {
  storageSettings = new StorageSettings(this, {
    objectDetectionDevice: {
      title: 'Object Detector',
      description: 'Select the object detection plugin to use for detecting objects.',
      type: 'device',
      deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}' && id !== '${nvrObjectDetertorId}'`,
      immediate: true,
    },
  });

  private previousDetectionsDic: Record<string, ObjectDetectionResult[]> = {};

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId);
  }

  getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  async applyDetectionsFilters(detected: ObjectsDetected, session: ObjectDetectionGeneratorSession) {
    const sessionSourceId = session.sourceId;
    const previousDetections = sessionSourceId ? this.previousDetectionsDic[sessionSourceId] : [];

    const srcData = cloneDeep(detected.detections);

    detected.timestamp = Date.now();
    detected.detections = filterBySettings(detected.detections, session.settings);
    detected.detections = filterOverlappedDetections(detected.detections);
    detected.detections = analyzeMovement(detected.detections, previousDetections)
      .filter(det => det.movement?.moving);

    this.previousDetectionsDic[sessionSourceId] = srcData;

    return detected;
  }

  async generateObjectDetections(videoFrames: AsyncGenerator<VideoFrame, void> | MediaObject, session: ObjectDetectionGeneratorSession): Promise<AsyncGenerator<ObjectDetectionGeneratorResult, void>> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;

    const originalGen = await objectDetection.generateObjectDetections(videoFrames, session);

    const transformedGen = async function* () {
      for await (const detect of originalGen) {
        detect.detected = await this.applyDetectionsFilters(detect.detected, session);

        yield detect;
      }
    }.bind(this);

    return transformedGen();
  }

  async detectObjects(mediaObject: MediaObject, session?: ObjectDetectionSession): Promise<ObjectsDetected> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    const res = await objectDetection.detectObjects(mediaObject, session);
    return this.applyDetectionsFilters(res, session);
  }

  async getDetectionModel(settings?: { [key: string]: any; }): Promise<ObjectDetectionModel> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    const model = await objectDetection.getDetectionModel(settings);

    if (model.settings) model.settings = [];
    const classnames = model.classes;

    if (classnames) {
      model.settings.push({
        key: 'enabledClasses',
        title: 'Detectioin classes',
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

  // analyzeMovement(currentFrame: ObjectDetectionResult[], sessionId: string): ObjectDetectionResult[] {
  //   const result = currentFrame.map(currentObj => {
  //     if (!currentObj.boundingBox || currentObj.className === 'motion') {
  //       return undefined;
  //     }
  //     // Find the most similar object from previous frame
  //     const bestMatch = findBestMatch(currentObj, sessionId ? this.previousFrame[sessionId] : []);

  //     // Deep clone the current object to avoid modifying the original
  //     const objWithMovement: ObjectDetectionResult = { ...currentObj };

  //     if (bestMatch) {
  //       const isMoving = detectMovement(currentObj, bestMatch.object);
  //       objWithMovement.movement = {
  //         moving: isMoving,
  //         firstSeen: currentObj.history?.firstSeen,
  //         lastSeen: Date.now()
  //       };
  //     } else {
  //       // New object - can't determine movement yet
  //       objWithMovement.movement = {
  //         moving: false,
  //         firstSeen: Date.now(),
  //         lastSeen: undefined
  //       };
  //     }

  //     return objWithMovement;
  //   });

  //   // Store current frame for next comparison
  //   this.previousFrame[sessionId] = currentFrame;

  //   return result;
  // }
}

export default ObjectDetectionPlugin;

