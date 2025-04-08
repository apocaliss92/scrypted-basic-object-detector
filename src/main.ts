import sdk, { VideoFrame, MediaObject, ObjectDetection, ObjectDetectionGenerator, ObjectDetectionGeneratorResult, ObjectDetectionGeneratorSession, ObjectDetectionModel, ObjectDetectionResult, ObjectDetectionSession, ObjectsDetected, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, SettingValue, Settings, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { detectMovement, filterOverlappedDetections, findBestMatch } from './util';

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

  private previousFrame: Record<string, ObjectDetectionResult[]> = {};

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId);
  }

  getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  async applyDetectionsFilters(detected: ObjectsDetected, sessionId: string) {
    detected.detections = filterOverlappedDetections(detected.detections);
    detected.detections = this.analyzeMovement(detected.detections, sessionId).filter(det => det.movement?.moving);
    detected.timestamp = Date.now();

    return detected;
  }

  async generateObjectDetections(videoFrames: AsyncGenerator<VideoFrame, void> | MediaObject, session: ObjectDetectionGeneratorSession): Promise<AsyncGenerator<ObjectDetectionGeneratorResult, void>> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    const originalGen = await objectDetection.generateObjectDetections(videoFrames, session);

    const transformedGen = async function* () {
      for await (const detect of originalGen) {
        detect.detected = await this.applyDetectionsFilters(detect.detected, session?.sourceId);

        yield detect;
      }
    }.bind(this);

    return transformedGen();
  }

  async detectObjects(mediaObject: MediaObject, session?: ObjectDetectionSession): Promise<ObjectsDetected> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    const res = await objectDetection.detectObjects(mediaObject, session);
    return this.applyDetectionsFilters(res, session?.sourceId);

  }

  getDetectionModel(settings?: { [key: string]: any; }): Promise<ObjectDetectionModel> {
    const objectDetection = this.storageSettings.values.objectDetectionDevice;
    return objectDetection.getDetectionModel(settings);
  }

  analyzeMovement(currentFrame: ObjectDetectionResult[], sessionId: string): ObjectDetectionResult[] {
    const result = currentFrame.map(currentObj => {
      if (!currentObj.boundingBox || currentObj.className === 'motion') {
        return undefined;
      }
      // Find the most similar object from previous frame
      const bestMatch = findBestMatch(currentObj, sessionId ? this.previousFrame[sessionId] : []);

      // Deep clone the current object to avoid modifying the original
      const objWithMovement: ObjectDetectionResult = { ...currentObj };

      if (bestMatch) {
        const isMoving = detectMovement(currentObj, bestMatch.object);
        objWithMovement.movement = {
          moving: isMoving,
          firstSeen: currentObj.history?.firstSeen,
          lastSeen: Date.now()
        };
      } else {
        // New object - can't determine movement yet
        objWithMovement.movement = {
          moving: false,
          firstSeen: Date.now(),
          lastSeen: undefined
        };
      }

      return objWithMovement;
    });

    // Store current frame for next comparison
    this.previousFrame[sessionId] = currentFrame;

    return result;
  }
}

export default ObjectDetectionPlugin;
