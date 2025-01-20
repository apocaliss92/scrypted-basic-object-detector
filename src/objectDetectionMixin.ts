import { Deferred } from '@scrypted/common/src/deferred';
import { sleep } from '@scrypted/common/src/sleep';
import sdk, { Camera, ClipPath, EventListenerRegister, MediaObject, MediaStreamDestination, MotionSensor, ObjectDetection, ObjectDetectionModel, ObjectDetectionTypes, ObjectDetectionZone, ObjectDetector, ObjectsDetected, ScryptedDevice, ScryptedInterface, Setting, Settings, VideoCamera, VideoFrame, VideoFrameGenerator, WritableDeviceState } from '@scrypted/sdk';
import crypto from 'crypto';
import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from './polygon';
import { getAllDevices, safeParseJson } from './util';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import ObjectDetectionPlugin from './main';

const { systemManager } = sdk;

const defaultPostMotionAnalysisDuration = 20;

const BUILTIN_MOTION_SENSOR_ASSIST = 'Assist';
const BUILTIN_MOTION_SENSOR_REPLACE = 'Replace';

type Zones = { [zone: string]: ClipPath };
interface ZoneInfo {
    exclusion?: boolean;
    filterMode?: 'include' | 'exclude' | 'observe';
    type?: 'Intersect' | 'Contain';
    classes?: string[];
    scoreThreshold?: number;
    secondScoreThreshold?: number;
}
type ZoneInfos = { [zone: string]: ZoneInfo };

export class ObjectDetectionMixin extends SettingsMixinDeviceBase<VideoCamera & Camera & MotionSensor & ObjectDetector> implements ObjectDetector, Settings {
    motionListener: EventListenerRegister;
    motionMixinListener: EventListenerRegister;
    detections = new Map<string, MediaObject>();
    cameraDevice: ScryptedDevice & Camera & VideoCamera & MotionSensor & ObjectDetector;
    storageSettings = new StorageSettings(this, {
        zones: {
            title: 'Zones',
            type: 'string',
            description: 'Enter the name of a new zone or delete an existing zone.',
            multiple: true,
            combobox: true,
            choices: [],
        },
        postMotionAnalysisDuration: {
            title: 'Post Motion Analysis Duration',
            subgroup: 'Advanced',
            description: 'The duration in seconds to analyze video after motion ends.',
            type: 'number',
            defaultValue: defaultPostMotionAnalysisDuration,
        },
    });
    motionTimeout: NodeJS.Timeout;
    detectionIntervalTimeout: NodeJS.Timeout;
    zones = this.getZones();
    zoneInfos = this.getZoneInfos();
    detectionStartTime: number;
    analyzeStop: number;
    detectorSignal = new Deferred<void>().resolve();
    released = false;
    sampleHistory: number[] = [];

    get detectorRunning() {
        return !this.detectorSignal.finished;
    }

    constructor(
        public plugin: ObjectDetectionPlugin,
        mixinDevice: VideoCamera & Camera & MotionSensor & ObjectDetector & Settings,
        mixinDeviceInterfaces: ScryptedInterface[],
        mixinDeviceState: WritableDeviceState,
        providerNativeId: string,
        public objectDetection: ObjectDetection & ScryptedDevice,
        public model: ObjectDetectionModel,
        group: string,
    ) {
        super({
            mixinDevice, mixinDeviceState,
            mixinProviderNativeId: providerNativeId,
            mixinDeviceInterfaces,
            group,
            groupKey: "basicObjectDetector:" + objectDetection.id,
            mixinStorageSuffix: objectDetection.id,
        });

        this.cameraDevice = systemManager.getDeviceById<Camera & VideoCamera & MotionSensor & ObjectDetector>(this.id);

        this.bindObjectDetection();
        this.register();

        this.storageSettings.settings.zones.mapGet = () => Object.keys(this.zones);
        this.storageSettings.settings.zones.onGet = async () => {
            return {
                group,
                choices: Object.keys(this.zones),
            }
        }
    }

    clearMotionTimeout() {
        clearTimeout(this.motionTimeout);
        this.motionTimeout = undefined;
    }

    getCurrentSettings() {
        const settings = this.model.settings;
        if (!settings)
            return { id: this.id };

        const ret: { [key: string]: any } = {};
        for (const setting of settings) {
            let value: any;
            if (setting.multiple) {
                value = safeParseJson(this.storage.getItem(setting.key));
                if (!value?.length)
                    value = undefined;
            }
            else {
                value = this.storage.getItem(setting.key);
                if (setting.type === 'number')
                    value = parseFloat(value);
            }
            value ||= setting.value;

            ret[setting.key] = value;
        }

        return {
            ...ret,
            id: this.id,
        };
    }

    maybeStartDetection() {
        // object detection may be restarted if there are slots available.
        if (this.cameraDevice.motionDetected && this.plugin.canStartObjectDetection(this)) {
            this.startPipelineAnalysis();
            return true;
        }
        return;

        // motion sensor should only be started when in replace mode
        if (this.motionSensorSupplementation === BUILTIN_MOTION_SENSOR_REPLACE)
            this.startPipelineAnalysis();
    }

    endObjectDetection() {
        this.detectorSignal.resolve();
    }

    bindObjectDetection() {
        this.endObjectDetection();
        this.maybeStartDetection();
    }

    async register() {
        this.motionListener = this.cameraDevice.listen(ScryptedInterface.MotionSensor, async () => {
            if (!this.cameraDevice.motionDetected) {
                // const minimumEndTme = this.detectionStartTime + this.storageSettings.values.minimumDetectionDuration * 1000;
                // const sleepTime = minimumEndTme - Date.now();
                const sleepTime = this.storageSettings.values.postMotionAnalysisDuration * 1000;

                if (sleepTime > 0) {
                    this.console.log('Motion stopped. Waiting additional time for minimum detection duration:', sleepTime);
                    await sleep(sleepTime);
                    if (this.motionDetected) {
                        this.console.log('Motion resumed during wait. Continuing detection.');
                        return;
                    }
                }

                if (this.detectorRunning) {
                    // allow anaysis due to user request.
                    if (this.analyzeStop > Date.now())
                        return;

                    this.console.log('Motion stopped, stopping detection.')
                    this.endObjectDetection();
                }
                return;
            }

            this.maybeStartDetection();
        });

        return;
    }

    startPipelineAnalysis() {
        if (!this.detectorSignal.finished || this.released)
            return;

        const signal = this.detectorSignal = new Deferred();
        this.detectionStartTime = Date.now();
        this.plugin.objectDetectionStarted(this.name, this.console);

        const options = {};

        const session = crypto.randomBytes(4).toString('hex');
        const typeName = 'object';
        this.console.log(`Video Analysis ${typeName} detection session ${session} started.`);

        this.runPipelineAnalysisLoop(signal, options)
            .catch(e => {
                this.console.error('Video Analysis ended with error', e);
            }).finally(() => {
                this.plugin.objectDetectionEnded(this.console);
                this.console.log(`Video Analysis ${typeName} detection session ${session} ended.`);
                signal.resolve();
            });
    }

    async runPipelineAnalysisLoop(signal: Deferred<void>, options: {
        suppress?: boolean,
    }) {
        await this.updateModel();
        while (!signal.finished) {
            if (options.suppress) {
                this.console.log('Resuming motion processing after active motion timeout.');
            }
            await this.runPipelineAnalysis(signal, options);
            options.suppress = true;

            return;
        }
    }

    async createFrameGenerator(frameGenerator: string,
        options: {
            suppress?: boolean,
        }, updatePipelineStatus: (status: string) => void): Promise<AsyncGenerator<VideoFrame, any, unknown> | MediaObject> {

        const destination: MediaStreamDestination = 'local-recorder';
        updatePipelineStatus('getVideoStream');
        const stream = await this.cameraDevice.getVideoStream({
            prebuffer: this.model.prebuffer,
            destination,
        });

        if (this.model.decoder) {
            if (!options?.suppress)
                this.console.log(this.objectDetection.name, '(with builtin decoder)');
            return stream;
        }

        const videoFrameGenerator = systemManager.getDeviceById<VideoFrameGenerator>(frameGenerator);
        if (!videoFrameGenerator)
            throw new Error('invalid VideoFrameGenerator');
        if (!options?.suppress)
            this.console.log(videoFrameGenerator.name, '+', this.objectDetection.name);
        updatePipelineStatus('generateVideoFrames');

        try {
            return await videoFrameGenerator.generateVideoFrames(stream, {
                queue: 0,
            });
        }
        finally {
            updatePipelineStatus('waiting first result');
        }
    }

    async runPipelineAnalysis(signal: Deferred<void>, options: {
        suppress?: boolean,
    }) {
        const start = Date.now();

        let lastStatusTime = Date.now();
        let lastStatus = 'starting';
        const updatePipelineStatus = (status: string) => {
            lastStatus = status;
            lastStatusTime = Date.now();
        }

        const interval = setInterval(() => {
            if (Date.now() - lastStatusTime > 30000) {
                signal.resolve();
                this.console.error('VideoAnalysis is hung and will terminate:', lastStatus);
            }
        }, 30000);
        signal.promise.finally(() => clearInterval(interval));

        const currentDetections = new Map<string, number>();
        let lastReport = 0;

        updatePipelineStatus('waiting result');

        const zones: ObjectDetectionZone[] = [];
        for (const mixin of this.plugin.currentMixins.values()) {
            if (mixin.id !== this.id)
                continue;
            for (const [key, zone] of Object.entries(mixin.zones)) {
                const zi = mixin.zoneInfos[key];
                if (!zone?.length || zone?.length < 3 || zi?.filterMode === 'observe')
                    continue;
                const odz: ObjectDetectionZone = {
                    classes: zi?.classes,
                    exclusion: zi?.filterMode ? zi?.filterMode === 'exclude' : zi?.exclusion,
                    path: zone,
                    type: zi?.type,
                }
                zones.push(odz);
            }
        }

        let longObjectDetectionWarning = false;

        const frameGenerator = this.model.decoder ? undefined : this.getFrameGenerator();
        for await (const detected of
            await sdk.connectRPCObject(
                await this.objectDetection.generateObjectDetections(
                    await this.createFrameGenerator(
                        frameGenerator,
                        options,
                        updatePipelineStatus), {
                    settings: {
                        ...this.getCurrentSettings(),
                        analyzeMode: !!this.analyzeStop,
                        frameGenerator,
                    },
                    sourceId: this.id,
                    zones,
                }))) {
            if (signal.finished) {
                break;
            }

            const now = Date.now();

            // stop when analyze period ends.
            if (this.analyzeStop && now > this.analyzeStop) {
                this.analyzeStop = undefined;
                break;
            }

            this.purgeSampleHistory(now);
            this.sampleHistory.push(now);

            if (!longObjectDetectionWarning && now - start > 5 * 60 * 1000) {
                longObjectDetectionWarning = true;
                this.console.warn('Camera has been performing object detection for 5 minutes due to persistent motion. This may adversely affect system performance. Read the Optimizing System Performance guide for tips and tricks. https://github.com/koush/nvr.scrypted.app/wiki/Optimizing-System-Performance')
            }

            // apply the zones to the detections and get a shallow copy list of detections after
            // exclusion zones have applied
            const originalDetections = detected.detected.detections;
            const zonedDetections = this.applyZones(detected.detected);
            detected.detected.detections = zonedDetections;

            this.plugin.trackDetection();

            const numZonedDetections = zonedDetections.filter(d => d.className !== 'motion').length;
            const numOriginalDetections = originalDetections.filter(d => d.className !== 'motion').length;
            if (numZonedDetections !== numOriginalDetections)
                currentDetections.set('filtered', (currentDetections.get('filtered') || 0) + 1);

            for (const d of detected.detected.detections) {
                currentDetections.set(d.className, Math.max(currentDetections.get(d.className) || 0, d.score));
            }

            if (now > lastReport + 10000) {
                const found = [...currentDetections.entries()].map(([className, score]) => `${className} (${score})`);
                if (!found.length)
                    found.push('[no detections]');
                this.console.log(`[${Math.round((now - start) / 100) / 10}s] Detected:`, ...found);
                sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, currentDetections);

                currentDetections.clear();
                lastReport = now;
            }

            if (detected.detected.detectionId) {
                updatePipelineStatus('creating jpeg');
                let { image } = detected.videoFrame;
                image = await sdk.connectRPCObject(image);
                const jpeg = await image.toBuffer({
                    format: 'jpg',
                });
                const mo = await sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
                this.setDetection(detected.detected, mo);
            }
            const motionFound = this.reportObjectDetections(detected.detected);
            updatePipelineStatus('waiting result');
        }
    }

    purgeSampleHistory(now: number) {
        while (this.sampleHistory.length && now - this.sampleHistory[0] > 10000) {
            this.sampleHistory.shift();
        }
    }

    get detectionFps() {
        const now = Date.now();
        this.purgeSampleHistory(now);
        const first = this.sampleHistory[0];
        // require at least 5 seconds of samples.
        if (!first || (now - first) < 8000)
            return Infinity;
        return this.sampleHistory.length / ((now - first) / 1000);
    }

    applyZones(detection: ObjectsDetected) {
        // determine zones of the objects, if configured.
        if (!detection.detections)
            return [];
        let copy = detection.detections.slice();
        for (const o of detection.detections) {
            if (!o.boundingBox)
                continue;

            const box = normalizeBox(o.boundingBox, detection.inputDimensions);

            let included: boolean;
            // need a way to explicitly include package zone.
            if (o.zones)
                included = true;
            else
                o.zones = [];
            for (const [zone, zoneValue] of Object.entries(this.zones)) {
                if (zoneValue.length < 3) {
                    // this.console.warn(zone, 'Zone is unconfigured, skipping.');
                    continue;
                }

                // object detection may report motion, don't filter these at all.
                if (o.className === 'motion')
                    continue;

                const zoneInfo = this.zoneInfos[zone];
                const exclusion = zoneInfo?.filterMode ? zoneInfo.filterMode === 'exclude' : zoneInfo?.exclusion;
                // track if there are any inclusion zones
                if (!exclusion && !included && zoneInfo?.filterMode !== 'observe')
                    included = false;

                let match = false;
                if (zoneInfo?.type === 'Contain') {
                    match = polygonContainsBoundingBox(zoneValue, box);
                }
                else {
                    match = polygonIntersectsBoundingBox(zoneValue, box);
                }

                const classes = zoneInfo?.classes?.length ? zoneInfo?.classes : this.model?.classes || [];
                if (match && classes.length) {
                    match = classes.includes(o.className);
                }
                if (match) {
                    o.zones.push(zone);

                    if (zoneInfo?.filterMode !== 'observe') {
                        if (exclusion && match) {
                            copy = copy.filter(c => c !== o);
                            break;
                        }

                        included = true;
                    }
                }
            }

            // if there are inclusion zones and this object
            // was not in any of them, filter it out.
            if (included === false)
                copy = copy.filter(c => c !== o);
        }

        return copy;
    }

    reportObjectDetections(detection: ObjectsDetected) {
        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);

        return false;
    }

    setDetection(detection: ObjectsDetected, detectionInput: MediaObject) {
        if (!detection.detectionId)
            detection.detectionId = crypto.randomBytes(4).toString('hex');

        this.console.log('retaining detection image', ...detection.detections);

        const { detectionId } = detection;
        this.detections.set(detectionId, detectionInput);
        setTimeout(() => {
            this.detections.delete(detectionId);
        }, 10000);
    }

    async getNativeObjectTypes(): Promise<ObjectDetectionTypes> {
        if (this.mixinDeviceInterfaces.includes(ScryptedInterface.ObjectDetector))
            return this.mixinDevice.getObjectTypes();
        return {};
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        const ret = await this.getNativeObjectTypes();
        if (!ret.classes)
            ret.classes = [];
        ret.classes.push(...(await this.objectDetection.getDetectionModel(this.getCurrentSettings())).classes);
        return ret;
    }

    async getDetectionInput(detectionId: any): Promise<MediaObject> {
        const detection = this.detections.get(detectionId);
        if (detection)
            return detection;
        if (this.mixinDeviceInterfaces.includes(ScryptedInterface.ObjectDetector))
            return this.mixinDevice.getDetectionInput(detectionId);
        throw new Error('Detection not found. It may have expired.');
    }

    get motionSensorSupplementation() {
        if (!this.interfaces.includes(ScryptedInterface.MotionSensor))
            return BUILTIN_MOTION_SENSOR_REPLACE;

        const supp = this.storage.getItem('motionSensorSupplementation');
        switch (supp) {
            case BUILTIN_MOTION_SENSOR_REPLACE:
                return BUILTIN_MOTION_SENSOR_REPLACE;
            case BUILTIN_MOTION_SENSOR_ASSIST:
                return BUILTIN_MOTION_SENSOR_ASSIST;
        }

        return BUILTIN_MOTION_SENSOR_REPLACE;
    }

    getFrameGenerator() {
        const frameGenerator = 'Default';

        const pipelines = getAllDevices().filter(d => d.interfaces.includes(ScryptedInterface.VideoFrameGenerator));
        const webassembly = sdk.systemManager.getDeviceById('@scrypted/nvr', 'decoder') || undefined;
        const gstreamer = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'gstreamer') || undefined;
        const libav = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'libav') || undefined;
        const ffmpeg = sdk.systemManager.getDeviceById('@scrypted/objectdetector', 'ffmpeg') || undefined;
        const use = pipelines.find(p => p.name === frameGenerator) || webassembly || gstreamer || libav || ffmpeg;
        return use.id;
    }

    async updateModel() {
        try {
            this.model = await this.objectDetection.getDetectionModel(this.getCurrentSettings());
        }
        catch (e) {
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = [];

        await this.updateModel();
        const modelSettings = this.model.settings;

        if (modelSettings) {
            settings.push(...modelSettings.map(setting => {
                let value: any;
                if (setting.multiple) {
                    value = safeParseJson(this.storage.getItem(setting.key));
                    if (!value?.length)
                        value = undefined;
                }
                else {
                    value = this.storage.getItem(setting.key);
                }
                value ||= setting.value;
                return Object.assign({}, setting, {
                    placeholder: setting.placeholder?.toString(),
                    value,
                } as Setting);
            }));
        }

        settings.push(...await this.storageSettings.getSettings());

        for (const [name, value] of Object.entries(this.zones)) {
            const zi = this.zoneInfos[name];

            const subgroup = `Zone: ${name}`;
            settings.push({
                subgroup,
                key: `zone-${name}`,
                title: `Open Zone Editor`,
                type: 'clippath',
                value: JSON.stringify(value),
            });

            settings.push({
                subgroup,
                key: `zoneinfo-filterMode-${name}`,
                title: `Filter Mode`,
                description: 'The filter mode used by this zone. The Default is include. Zones set to observe will not affect filtering and can be used for automations.',
                choices: [
                    'Default',
                    'include',
                    'exclude',
                    'observe',
                ],
                value: zi?.filterMode || (zi?.exclusion ? 'exclude' : undefined) || 'Default',
            });

            settings.push({
                subgroup,
                key: `zoneinfo-type-${name}`,
                title: `Zone Type`,
                description: 'An Intersect zone will match objects that are partially or fully inside the zone. A Contain zone will only match objects that are fully inside the zone.',
                choices: [
                    'Intersect',
                    'Contain',
                ],
                value: zi?.type || 'Intersect',
            });

            const classes = this.model.classes;
            settings.push(
                {
                    subgroup,
                    key: `zoneinfo-classes-${name}`,
                    title: `Detection Classes`,
                    description: 'The detection classes to match inside this zone.',
                    choices: classes || [],
                    value: zi?.classes?.length ? zi?.classes : classes || [],
                    multiple: true,
                },
            );
        }

        return settings;
    }

    getZones(): Zones {
        try {
            return JSON.parse(this.storage.getItem('zones'));
        }
        catch (e) {
            return {};
        }
    }

    getZoneInfos(): ZoneInfos {
        try {
            return JSON.parse(this.storage.getItem('zoneInfos'));
        }
        catch (e) {
            return {};
        }
    }

    async putMixinSetting(key: string, value: string | number | boolean | string[] | number[]): Promise<void> {
        let vs = value?.toString();

        if (key === 'zones') {
            const newZones: Zones = {};
            const newZoneInfos: ZoneInfos = {};
            for (const name of value as string[]) {
                newZones[name] = this.zones[name] || [];
                newZoneInfos[name] = this.zoneInfos[name];
            }
            this.zones = newZones;
            this.zoneInfos = newZoneInfos;
            this.storage.setItem('zones', JSON.stringify(newZones));
            this.storage.setItem('zoneInfos', JSON.stringify(newZoneInfos));
            return;
        }
        if (key.startsWith('zone-')) {
            const zoneName = key.substring('zone-'.length);
            if (this.zones[zoneName]) {
                this.zones[zoneName] = Array.isArray(value) ? value : JSON.parse(vs);
                this.storage.setItem('zones', JSON.stringify(this.zones));
            }
            return;
        }
        if (key.startsWith('zoneinfo-')) {
            const [zkey, zoneName] = key.substring('zoneinfo-'.length).split('-');
            this.zoneInfos[zoneName] ||= {};
            this.zoneInfos[zoneName][zkey] = value;
            this.storage.setItem('zoneInfos', JSON.stringify(this.zoneInfos));
            return;
        }

        if (this.storageSettings.settings[key]) {
            return this.storageSettings.putSetting(key, value);
        }

        if (value) {
            const found = this.model.settings?.find(s => s.key === key);
            if (found?.multiple || found?.type === 'clippath')
                vs = JSON.stringify(value);
        }

        const settings = this.getCurrentSettings();
        if (settings && key in settings) {
            this.storage.setItem(key, vs);
            settings[key] = value;
        }
        this.bindObjectDetection();
    }

    async release() {
        this.released = true;
        super.release();
        this.clearMotionTimeout();
        clearInterval(this.detectionIntervalTimeout);
        this.motionListener?.removeListener();
        this.motionMixinListener?.removeListener();
        this.endObjectDetection();
    }
}