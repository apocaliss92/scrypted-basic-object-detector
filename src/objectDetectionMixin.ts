import { Deferred } from '@scrypted/common/src/deferred';
import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { sleep } from '@scrypted/common/src/sleep';
import sdk, { Camera, ClipPath, EventListenerRegister, MediaObject, MediaStreamDestination, MotionSensor, ObjectDetection, ObjectDetectionModel, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetectionZone, ObjectDetector, ObjectsDetected, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, VideoCamera, VideoFrame, VideoFrameGenerator, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import ObjectDetectionPlugin from './main';
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from './polygon';
import { calculateDistance, detectMovement, filterDetections, findBestMatch, getAllDevices, MovementState, Position, safeParseJson } from './util';

const { systemManager } = sdk;

const defaultPostMotionAnalysisDuration = 20;

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
    cameraDevice: ScryptedDeviceBase & ScryptedDevice & Camera & VideoCamera & MotionSensor & ObjectDetector;
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
    hasMotionType: boolean;
    lastMotionReported: number;

    private previousFrame: ObjectDetectionResult[] = [];

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

        this.cameraDevice = systemManager.getDeviceById<ScryptedDeviceBase & Camera & VideoCamera & MotionSensor & ObjectDetector>(this.id);

        this.bindObjectDetection();
        this.register();

        if (this.hasMotionType) {
            this.detectionIntervalTimeout = setInterval(async () => {
                if (this.released)
                    return;
                this.maybeStartDetection();
            }, 60000);
        }

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

        if (this.hasMotionType)
            ret['motionAsObjects'] = true;

        return {
            ...ret,
            id: this.id,
        };
    }

    maybeStartDetection() {
        if (!this.hasMotionType) {
            if (this.cameraDevice.motionDetected && this.plugin.canStartObjectDetection(this)) {
                this.startPipelineAnalysis();
                return true;
            }
            return;
        }
    }

    endObjectDetection() {
        this.detectorSignal.resolve();
    }

    bindObjectDetection() {
        // if (this.hasMotionType)
        //     this.motionDetected = false;

        this.endObjectDetection();
        this.maybeStartDetection();
    }

    async register() {
        if (!this.hasMotionType) {
            this.motionListener = this.cameraDevice.listen(ScryptedInterface.MotionSensor, async () => {
                const timestamp = Date.now();
                if (!this.lastMotionReported || (timestamp - this.lastMotionReported) > 1000 * 1) {
                    this.lastMotionReported = timestamp;
                    const motionObject: ObjectsDetected = {
                        timestamp,
                        detections: [{ className: 'motion', score: 1 }],
                        detectionId: crypto.randomBytes(4).toString('hex')
                    };

                    this.onDeviceEvent(ScryptedInterface.ObjectDetector, motionObject);
                }

                if (!this.cameraDevice.motionDetected) {
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
                        if (this.analyzeStop > timestamp)
                            return;

                        this.console.log('Motion stopped, stopping detection.')
                        this.endObjectDetection();
                    }
                    return;
                }

                this.maybeStartDetection();
            });

            return;
        } else {
            this.motionMixinListener = this.cameraDevice.listen({
                event: ScryptedInterface.MotionSensor,
                mixinId: this.id,
            }, async (_, __, data) => {
                if (data) {
                    if (this.motionDetected)
                        return;
                    if (!this.detectorRunning)
                        this.console.log('Built in motion sensor started motion, starting video detection.');
                    this.startPipelineAnalysis();
                    return;
                }

                this.clearMotionTimeout();
                if (this.detectorRunning) {
                    this.console.log('Built in motion sensor ended motion, stopping video detection.')
                    this.endObjectDetection();
                }
                // if (this.motionDetected)
                //     this.motionDetected = false;
            });
        }
    }

    startPipelineAnalysis() {
        if (!this.detectorSignal.finished || this.released)
            return;

        const signal = this.detectorSignal = new Deferred();
        this.detectionStartTime = Date.now();
        if (!this.hasMotionType)
            this.plugin.objectDetectionStarted(this.name, this.console);

        const options = {};

        const session = crypto.randomBytes(4).toString('hex');
        const typeName = this.hasMotionType ? 'motion' : 'object';
        this.console.log(`Video Analysis ${typeName} detection session ${session} started.`);

        this.runPipelineAnalysisLoop(signal, options)
            .catch(e => {
                this.console.error('Video Analysis ended with error', e);
            }).finally(() => {
                if (!this.hasMotionType)
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

        const destination: MediaStreamDestination = this.hasMotionType ? 'low-resolution' : 'local-recorder';
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
                fps: this.hasMotionType ? 4 : undefined,
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
            if (!this.hasMotionType && this.analyzeStop && now > this.analyzeStop) {
                this.analyzeStop = undefined;
                break;
            }

            this.purgeSampleHistory(now);
            this.sampleHistory.push(now);

            if (!longObjectDetectionWarning && !this.hasMotionType && now - start > 5 * 60 * 1000) {
                longObjectDetectionWarning = true;
                this.console.warn('Camera has been performing object detection for 5 minutes due to persistent motion. This may adversely affect system performance. Read the Optimizing System Performance guide for tips and tricks. https://github.com/koush/nvr.scrypted.app/wiki/Optimizing-System-Performance')
            }

            // apply the zones to the detections and get a shallow copy list of detections after
            // exclusion zones have applied
            const originalDetections = detected.detected.detections;
            const zonedDetections = this.applyZones(detected.detected);
            detected.detected.detections = filterDetections(zonedDetections);
            detected.detected.timestamp = Date.now();

            if (!this.hasMotionType) {
                this.plugin.trackDetection();

                const numZonedDetections = zonedDetections.filter(d => d.className !== 'motion').length;
                const numOriginalDetections = originalDetections.filter(d => d.className !== 'motion').length;
                if (numZonedDetections !== numOriginalDetections)
                    currentDetections.set('filtered', (currentDetections.get('filtered') || 0) + 1);

                detected.detected.detections = this.analyzeMovement(detected.detected.detections).filter(det => det.movement?.moving);
                for (const d of detected.detected.detections) {
                    currentDetections.set(d.className, Math.max(currentDetections.get(d.className) || 0, d.score));
                }

                if (now > lastReport + 10000) {
                    const found = [...currentDetections.entries()].map(([className, score]) => `${className} (${score})`);
                    if (!found.length)
                        found.push('[no detections]');
                    this.console.log(`[${Math.round((now - start) / 100) / 10}s] Detected:`, ...found);
                    currentDetections.clear();
                    lastReport = now;
                }
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

            if (this.hasMotionType) {
                if (motionFound) {
                    if (!this.analyzeStop || now > this.analyzeStop) {
                        this.analyzeStop = undefined;
                        clearInterval(interval);
                        return true;
                    }
                }
                await sleep(250);
            }
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
                if (!this.hasMotionType && o.className === 'motion')
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

            // if this is a motion sensor and there are no inclusion zones set up,
            // use a default inclusion zone that crops the top and bottom to
            // prevents errant motion from the on screen time changing every second.
            if (this.hasMotionType && included === undefined) {
                const defaultInclusionZone: ClipPath = [[0, .1], [1, .1], [1, .9], [0, .9]];
                included = polygonIntersectsBoundingBox(defaultInclusionZone, box);
            }

            // if there are inclusion zones and this object
            // was not in any of them, filter it out.
            if (included === false)
                copy = copy.filter(c => c !== o);
        }

        return copy;
    }

    reportObjectDetections(detection: ObjectsDetected) {
        let motionFound = false;
        if (this.hasMotionType) {
            motionFound = !!detection.detections?.find(d => d.className === 'motion');
            if (motionFound) {
                // if (!this.motionDetected)
                //     this.motionDetected = true;

                const areas = detection.detections.filter(d => d.className === 'motion' && d.score !== 1).map(d => d.score)
                if (areas.length)
                    this.console.log('detection areas', areas);
            }
        }

        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
        return motionFound;
    }

    analyzeMovement(currentFrame: ObjectDetectionResult[]): ObjectDetectionResult[] {
        const result = currentFrame.map(currentObj => {
            if (!currentObj.boundingBox || currentObj.className === 'motion') {
                return undefined;
            }
            // Find the most similar object from previous frame
            const bestMatch = findBestMatch(currentObj, this.previousFrame);

            // Deep clone the current object to avoid modifying the original
            const objWithMovement: ObjectDetectionResult = { ...currentObj };

            if (bestMatch) {
                const isMoving = detectMovement(currentObj, bestMatch.object);
                objWithMovement.movement = {
                    moving: isMoving,
                    firstSeen: currentObj.history?.firstSeen,
                    lastSeen: currentObj.history?.lastSeen
                };
            } else {
                // New object - can't determine movement yet
                objWithMovement.movement = {
                    moving: false,
                    firstSeen: currentObj.history?.firstSeen,
                    lastSeen: currentObj.history?.lastSeen
                };
            }

            return objWithMovement;
        });

        // Store current frame for next comparison
        this.previousFrame = currentFrame;

        return result;
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

    getFrameGenerator() {
        const pipelines = getAllDevices().filter(d => d.interfaces.includes(ScryptedInterface.VideoFrameGenerator));
        const webassembly = sdk.systemManager.getDeviceById('@scrypted/nvr', 'decoder') || undefined;
        const gstreamer = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'gstreamer') || undefined;
        const libav = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'libav') || undefined;
        const ffmpeg = sdk.systemManager.getDeviceById('@scrypted/objectdetector', 'ffmpeg') || undefined;
        const use = pipelines.find(p => p.name === 'Default') || webassembly || gstreamer || libav || ffmpeg;
        return use.id;
    }

    async updateModel() {
        try {
            this.model = await this.objectDetection.getDetectionModel(this.getCurrentSettings());
            this.hasMotionType = this.model.classes.includes('motion');
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

            if (!this.hasMotionType) {
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