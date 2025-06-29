import { ObjectDetectionGeneratorSession, ObjectDetectionResult, ObjectsDetected, Point } from "@scrypted/sdk";
import { randomBytes } from "crypto";
import { Munkres } from 'munkres-js';
import { BoundingBox, calculateIoU, getClassnameSettings, prefilterDetections } from "./util";
import { isEqual, sortBy, uniq } from "lodash";

interface TrackedObject extends ObjectDetectionResult {
    hits: number;
    misses: number;
    lostFrames: number;
    active: boolean;
}

export class ObjectTracker {
    maxMisses: number;
    maxEmptyFrames: number;
    lastDetectionId: number;
    tracks: Map<string, TrackedObject>;
    lostTracks: Map<string, TrackedObject>;
    lastActiveIds: Set<string>;
    nextTrackId: number;
    maxLostFrames: number;
    logger: Console;
    session: ObjectDetectionGeneratorSession;
    sessionId = randomBytes(2).toString('hex');
    currentFrame = 0;
    useMatrix = false;
    emptyFrameCount = 0;
    lastActiveClasses: string[] = []

    constructor({
        maxMisses = 5,
        maxEmptyFrames = 3,
        logger,
        session
    }) {
        this.maxMisses = maxMisses;
        this.session = session;
        this.maxEmptyFrames = maxEmptyFrames;
        this.logger = logger;
        this.tracks = new Map();
        this.lastActiveIds = new Set();
        this.nextTrackId = 1;
        this.lostTracks = new Map();
        this.maxLostFrames = 50;
    }

    getCentroid(bbox: BoundingBox): Point {
        return [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2];
    }

    getNewDetectionId() {
        return `${this.sessionId}-${this.currentFrame}`;
    }

    matchWithActiveTracks(det: ObjectDetectionResult) {
        let bestMatch = null;
        let bestIOU = 0;

        for (const [trackId, track] of this.tracks) {
            if (track.className !== det.className) continue;

            const iou = calculateIoU(det.boundingBox, track.boundingBox);
            const { iouThresholdSetting } = getClassnameSettings(track.className);
            const iouThreshold = this.session.settings[iouThresholdSetting];
            if (iou > iouThreshold && iou > bestIOU) {
                bestIOU = iou;
                bestMatch = trackId;
            }
        }

        return bestMatch;
    }

    // matchWithLostTracks(det: ObjectDetectionResult) {
    //     let bestMatchId = null;
    //     let bestScore = 0;
    //     let bestIOU = this.iouMatchThreshold;

    //     for (const [id, track] of this.lostTracks) {
    //         if (track.className !== det.className) continue;

    //         const iou = calculateIoU(det.boundingBox, track.boundingBox);
    //         const scoreSim = 1 - Math.abs((track.score || 0) - (det.score || 0));

    //         if (iou > bestIOU && scoreSim > 0.6) {
    //             bestIOU = iou;
    //             bestMatchId = id;
    //             bestScore = scoreSim;
    //         }
    //     }

    //     return bestMatchId;
    // }
    matchWithLostTracks(det: ObjectDetectionResult) {
        const { iouThresholdSetting } = getClassnameSettings(det.className);
        const iouThreshold = this.session.settings[iouThresholdSetting];
        let bestMatchId = null;
        let bestIOU = iouThreshold;

        for (const [id, track] of this.lostTracks) {
            if (track.className !== det.className) continue;

            const iou = calculateIoU(det.boundingBox, track.boundingBox);
            if (iou > bestIOU) {
                bestIOU = iou;
                bestMatchId = id;
            }
        }

        return bestMatchId;
    }

    processWithMatrix(detections: ObjectDetectionResult[]) {
        const assignedTracks = new Set();
        const updatedTrackIds = new Set();
        const newlyConfirmedIds = new Set();

        const activeTrackEntries = Array.from(this.tracks.entries());
        const costMatrix: number[][] = [];

        for (const det of detections) {
            const row: number[] = [];
            for (const [, track] of activeTrackEntries) {
                const iou = calculateIoU(det.boundingBox, track.boundingBox);
                row.push(1 - iou);
            }
            costMatrix.push(row);
        }

        let assignments: [number, number][] = [];

        if (costMatrix.length > 0 && costMatrix[0].length > 0) {
            const munkres = new Munkres();
            assignments = munkres.compute(costMatrix);
        }

        for (const [detIdx, trackIdx] of assignments) {
            const cost = costMatrix[detIdx][trackIdx];
            const det = detections[detIdx];
            const { iouThresholdSetting, minConfirmationFramesSetting, movementThresholdSetting } = getClassnameSettings(det.className);
            const iouThreshold = this.session.settings[iouThresholdSetting];
            const minConfirmations = this.session.settings[minConfirmationFramesSetting];
            const movementThreshold = this.session.settings[movementThresholdSetting];

            if (cost > (1 - iouThreshold)) continue;

            const [trackId, track] = activeTrackEntries[trackIdx];

            const oldCentroid = this.getCentroid(track.boundingBox);
            const newCentroid = this.getCentroid(det.boundingBox);
            const movement = this.distance(oldCentroid, newCentroid);
            const now = Date.now();

            track.boundingBox = det.boundingBox;
            track.className = det.className;
            track.label = det.label;
            track.score = det.score;
            track.hits++;
            track.misses = 0;
            track.active = track.active || track.hits >= minConfirmations;
            track.movement.lastSeen = now;
            track.movement.moving = movement >= movementThreshold;

            if (!track.active && track.hits >= minConfirmations) {
                this.logger.log(`Track ${trackId} ${det.className} confirmed`);
                track.active = true;
                newlyConfirmedIds.add(track.id);
            }

            assignedTracks.add(trackId);
            updatedTrackIds.add(trackId);
        }

        for (let i = 0; i < detections.length; i++) {
            const wasAssigned = assignments.some(([detIdx]) => detIdx === i);
            if (!wasAssigned) {
                const det = detections[i];
                const now = Date.now();
                const newId = (this.nextTrackId++).toString(36);
                this.tracks.set(newId, {
                    id: newId,
                    boundingBox: det.boundingBox,
                    className: det.className,
                    score: det.score,
                    label: det.label,
                    hits: 1,
                    misses: 0,
                    lostFrames: 0,
                    active: false,
                    movement: {
                        firstSeen: now,
                        lastSeen: undefined,
                        moving: false,
                    }
                });
                updatedTrackIds.add(newId);
            }
        }

        return {
            assignedTracks,
            updatedTrackIds,
            newlyConfirmedIds,
        }
    }

    processWithIOU(detections: ObjectDetectionResult[]) {
        const assignedTracks = new Set();
        const updatedTrackIds = new Set();
        const newlyConfirmedIds = new Set();
        const now = Date.now();

        for (const det of detections) {
            const matchId = this.matchWithActiveTracks(det);

            const { minConfirmationFramesSetting, movementThresholdSetting } = getClassnameSettings(det.className);
            const minConfirmations = this.session.settings[minConfirmationFramesSetting];
            const movementThreshold = this.session.settings[movementThresholdSetting];

            if (matchId && !assignedTracks.has(matchId)) {
                const track = this.tracks.get(matchId);

                if (!track) continue;

                const oldCentroid = this.getCentroid(track.boundingBox);
                const newCentroid = this.getCentroid(det.boundingBox);
                const movement = this.distance(oldCentroid, newCentroid);

                if (!track.movement) {
                    track.movement = { firstSeen: undefined, lastSeen: undefined, moving: false };
                }

                track.boundingBox = det.boundingBox;
                track.className = det.className;
                track.label = det.label;
                track.score = det.score;
                track.hits++;
                track.misses = 0;
                track.active = track.active || track.hits >= minConfirmations;
                track.movement.lastSeen = now;
                track.movement.moving = movement >= movementThreshold;

                if (!track.active && (track.hits >= minConfirmations || !minConfirmations)) {
                    this.logger.log(`Track ${track.id} ${det.className} confirmed`);
                    track.active = true;
                    newlyConfirmedIds.add(track.id);
                }

                assignedTracks.add(matchId);
                updatedTrackIds.add(matchId);
                continue;
            }

            // Try match with lost tracks
            const lostMatchId = this.matchWithLostTracks(det);
            if (lostMatchId && !assignedTracks.has(lostMatchId)) {
                const track = this.lostTracks.get(lostMatchId);

                if (!track) continue;

                this.logger.log(`Lost track ${track.id} ${track.className} resumed`);

                const oldCentroid = this.getCentroid(track.boundingBox);
                const newCentroid = this.getCentroid(det.boundingBox);
                const movement = this.distance(oldCentroid, newCentroid);

                track.boundingBox = det.boundingBox;
                track.className = det.className;
                track.label = det.label;
                track.score = det.score;
                track.hits++;
                track.misses = 0;
                track.active = track.hits >= minConfirmations;
                track.lostFrames = 0;
                track.movement.lastSeen = now;
                track.movement.moving = movement >= movementThreshold;

                if (!track.active && (track.hits >= minConfirmations || !minConfirmations)) {
                    this.logger.log(`Track ${track.id} ${det.className} lost and confirmed`);
                    track.active = true;
                    newlyConfirmedIds.add(track.id);
                }

                this.tracks.set(track.id, track);
                this.lostTracks.delete(track.id);

                assignedTracks.add(lostMatchId);
                updatedTrackIds.add(lostMatchId);
                continue;
            }

            // No match: new track
            const newId = (this.nextTrackId++).toString(36);

            const track = {
                id: newId,
                boundingBox: det.boundingBox,
                className: det.className,
                label: det.label,
                score: det.score,
                hits: 1,
                misses: 0,
                lostFrames: 0,
                active: false,
                movement: {
                    firstSeen: now,
                    lastSeen: undefined,
                    moving: false,
                }
            };

            if (!minConfirmations || minConfirmations <= 1) {
                this.logger.log(`Track ${newId} ${det.className} created and confirmed`);
                track.active = true;

                assignedTracks.add(track.id);
                newlyConfirmedIds.add(track.id);
            } else {
                this.logger.log(`Track ${newId} ${det.className} started (${minConfirmations} frames for confirmation)`);
            }

            this.tracks.set(newId, track);
            updatedTrackIds.add(newId);
        }

        return {
            assignedTracks,
            updatedTrackIds,
            newlyConfirmedIds,
        }
    }

    addMotionEntries(detections: ObjectDetectionResult[]) {
        if (!detections.length) {
            return [({
                className: 'motion',
                score: 1
            })];
        } else {
            return detections.map(det => ({
                boundingBox: det.boundingBox,
                className: 'motion',
                score: 1
            }));
        }
    }

    buildActiveTracks() {
        const active: ObjectDetectionResult[] = [];
        const pending: ObjectDetectionResult[] = [];

        for (const track of this.tracks.values()) {
            (track.active ? active : pending).push({
                className: track.className,
                score: track.score,
                boundingBox: track.boundingBox,
                movement: track.movement,
                id: track.id,
                label: track.label,
                history: track.history
            });
        }

        active.push(...this.addMotionEntries(active));

        return { active, pending };
    }


    update(detected: ObjectsDetected, basicDetectionsOnly: boolean) {
        const detectionsRaw: ObjectDetectionResult[] = detected.detections || [];

        // if ((!detectionsRaw || detectionsRaw.length === 0) && this.emptyFrameCount++ < this.maxEmptyFrames) {
        //     this.logger.debug(`No detections received on frame ${this.currentFrame}, preserving state.`);

        //     const { active, pending } = this.buildActiveTracks();

        //     const detectionId = undefined;

        //     this.currentFrame++;

        //     return { active, pending, detectionId };
        // }

        this.emptyFrameCount = 0;

        const detections = prefilterDetections({
            detections: detectionsRaw,
            inputDimensions: detected.inputDimensions,
            settings: this.session.settings,
        });

        this.logger.debug(`Prefiltered result: ${JSON.stringify(detections)}`);

        if (basicDetectionsOnly) {
            detections.push(...this.addMotionEntries(detections));

            this.currentFrame++;

            return { active: detections, pending: [], detectionId: undefined };
        }

        const {
            newlyConfirmedIds,
            updatedTrackIds
        } = this.useMatrix ?
                this.processWithMatrix(detections) :
                this.processWithIOU(detections);

        // Check not updated tracks
        for (const [trackId, track] of this.tracks) {
            if (!updatedTrackIds.has(trackId)) {
                track.misses++;
                if (track.misses >= this.maxMisses) {
                    track.lostFrames = 0;
                    this.lostTracks.set(track.id, track);
                    this.tracks.delete(trackId);
                } else {
                    track.movement.moving = false;
                }
            }
        }

        // Cleanup old lost tracks
        for (const [id, lostTrack] of this.lostTracks) {
            lostTrack.lostFrames++;
            if (lostTrack.lostFrames > this.maxLostFrames) {
                this.logger.log(`Track ${lostTrack.id} ${lostTrack.className} lost for too long, removing`);
                this.lostTracks.delete(id);
            }
        }

        const { active, pending } = this.buildActiveTracks();
        const activeClasses = sortBy(active.map(item => item.className));

        const now = Date.now();
        const currentActiveIds = new Set(active.map(t => t.id));
        const sceneChanged =
            newlyConfirmedIds.size > 0 ||
            this.lastActiveIds.size === 0 && currentActiveIds.size > 0 ||
            [...this.lastActiveIds].some(id => !currentActiveIds.has(id))
            || (!!active.length && (!this.lastDetectionId || (now - this.lastDetectionId) > 5 * 1000))
        // || !isEqual(activeClasses, this.lastActiveClasses)

        const detectionId = sceneChanged ? this.getNewDetectionId() : undefined;

        if (detectionId) {
            this.lastDetectionId = now;
        }

        this.lastActiveIds = currentActiveIds;
        this.lastActiveClasses = activeClasses;

        this.currentFrame++;

        return { active, pending, detectionId };
    }

    distance(c1: Point, c2: Point) {
        return Math.sqrt((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2);
    }
} 