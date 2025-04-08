import sdk, { MediaObject, ObjectDetection, ObjectDetectionGenerator, ObjectDetectionGeneratorResult, ObjectDetectionGeneratorSession, ObjectDetectionModel, ObjectDetectionResult, ObjectDetectionSession, ObjectsDetected, ScryptedDeviceBase, ScryptedNativeId, Setting, SettingValue, Settings, VideoFrame } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { randomBytes } from 'crypto';
import cloneDeep from 'lodash/cloneDeep';
import { calculateIoU, detectMovement, filterOverlappedDetections, findBestMatch, SessionManager } from './util';

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

  previousDetectionsDic: Record<string, ObjectDetectionResult[]> = {};
  sourceDeviceData: Record<string, {
    isFirstFrame: boolean,
    frameNumber: number,
    objectsCounter: number,
    sessionId: string,
    begin: number
  }> = {};

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId);
  }

  getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  getNewObjectId(sessionId: string) {
    return (this.sourceDeviceData[sessionId].objectsCounter++).toString(36);
  }

  getNewDedetctionId(frameNumber: number, sourceId: string) {
    return `${this.sourceDeviceData[sourceId].sessionId}-${frameNumber}`;
  }

  analyzeMovement(
    currentFrame: ObjectDetectionResult[],
    previousFrames: ObjectDetectionResult[] = [],
    session: ObjectDetectionGeneratorSession
  ) {
    let anyNewObject = false;

    const result = currentFrame.map(currentObj => {
      if (!currentObj.boundingBox || currentObj.className === 'motion') {
        return undefined;
      }
      // Find the most similar object from previous frame
      const bestMatch = findBestMatch(currentObj, previousFrames);

      // Deep clone the current object to avoid modifying the original
      const objWithMovement: ObjectDetectionResult = { ...currentObj };

      if (bestMatch) {
        const isMoving = detectMovement(currentObj, bestMatch);
        objWithMovement.movement = {
          moving: isMoving,
          firstSeen: currentObj.history?.firstSeen,
          lastSeen: Date.now(),
        };
        objWithMovement.id = bestMatch?.id || this.getNewObjectId(session.sourceId);
      } else {
        // New object - can't determine movement yet
        objWithMovement.movement = {
          moving: false,
          firstSeen: Date.now(),
          lastSeen: undefined
        };
        objWithMovement.id = this.getNewObjectId(session.sourceId);
        anyNewObject = true;
      }

      return objWithMovement;
    });

    return { newDetections: result, anyNewObject };
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

  async applyDetectionsFilters(detected: ObjectsDetected, session: ObjectDetectionGeneratorSession) {
    const sessionSourceId = session.sourceId;
    const previousDetections = sessionSourceId ? this.previousDetectionsDic[sessionSourceId] : [];

    const sourceData = this.sourceDeviceData[session.sourceId];

    detected.timestamp = Date.now();
    detected.detections = this.filterBySettings(detected.detections, session.settings);
    detected.detections = filterOverlappedDetections(detected.detections);
    const { anyNewObject, newDetections } = this.analyzeMovement(detected.detections, previousDetections, session);
    detected.detections = newDetections;

    if (sourceData?.isFirstFrame || anyNewObject) {
      detected.detectionId = this.getNewDedetctionId(sourceData?.frameNumber, session.sourceId);
    }

    this.previousDetectionsDic[sessionSourceId] = cloneDeep(detected.detections);
    detected.detections.push({
      className: "motion",
      score: 1
    });

    return detected;
  }

  resetSourceData(sessionId: string) {
    this.sourceDeviceData[sessionId] = {
      isFirstFrame: true,
      frameNumber: 1,
      objectsCounter: 0,
      sessionId: randomBytes(2).toString('hex'),
      begin: Date.now(),
    }
  }

  async generateObjectDetections(videoFrames: AsyncGenerator<VideoFrame, void> | MediaObject, session: ObjectDetectionGeneratorSession): Promise<AsyncGenerator<ObjectDetectionGeneratorResult, void>> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    const logger = sdk.deviceManager.getMixinConsole(session.sourceId, this.nativeId);

    const originalGen = await objectDetection.generateObjectDetections(videoFrames, session);
    this.resetSourceData(session.sourceId);

    const transformedGen = async function* () {
      for await (const detect of originalGen) {
        const now = Date.now();
        const sourceData = this.sourceDeviceData[session.sourceId];
        if (now - sourceData.begin > 30 * 1000) {
          this.resetSourceData(session.sourceId);
        }
        detect.detected = await this.applyDetectionsFilters(detect.detected, session);

        sourceData.isFirstFrame = false;
        sourceData.frameNumber++;
        // logger.log(JSON.stringify(detect.detected));

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
}

export default ObjectDetectionPlugin;

