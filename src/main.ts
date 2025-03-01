import sdk, { ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, SettingValue, Settings, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ObjectDetectionMixin } from './objectDetectionMixin';

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById('@scrypted/nvr', 'motion')?.id;
export const nvrObjectDetertorId = sdk.systemManager.getDeviceByName('Scrypted NVR Object Detection')?.id;

export class ObjectDetectionPlugin extends ScryptedDeviceBase implements Settings {
  currentMixins = new Set<ObjectDetectionMixin>();
  storageSettings = new StorageSettings(this, {
    objectDetectionDevice: {
      title: 'Object Detector',
      description: 'Select the object detection plugin to use for detecting objects.',
      type: 'device',
      deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}' && id !== '${nvrObjectDetertorId}'`,
      immediate: true,
    },
  });
  devices = new Map<string, any>();

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId);
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
