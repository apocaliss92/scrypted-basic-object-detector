import { ObjectDetectionGeneratorSession, ObjectDetectionResult, Point } from "@scrypted/sdk";
import { randomBytes } from "crypto";
import { Munkres } from 'munkres-js';
import { BoundingBox, calculateIoU, prefilterDetections } from "./util";

interface TrackedObject extends ObjectDetectionResult {
    hits: number;
    misses: number;
    lostFrames: number;
    active: boolean;
}

export class ObjectTracker {
    minConfirmations: number;
    maxMisses: number;
    movementThreshold: number;
    iouMatchThreshold: number;
    iouNmsThreshold: number;
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

    constructor({
        minConfirmations = 3,
        maxMisses = 5,
        movementThreshold = 10,
        iouMatchThreshold = 0.3,
        iouNmsThreshold = 0.5,
        logger,
        session
    }) {
        this.minConfirmations = minConfirmations;
        this.maxMisses = maxMisses;
        this.session = session;
        this.movementThreshold = movementThreshold;
        this.iouMatchThreshold = iouMatchThreshold;
        this.iouNmsThreshold = iouNmsThreshold;
        this.logger = logger;
        this.tracks = new Map();
        this.lastActiveIds = new Set();
        this.nextTrackId = 1;
        this.lostTracks = new Map();
        this.maxLostFrames = 30;

        logger.log(`Object tracker session ${this.sessionId} started`);
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
            const iou = calculateIoU(det.boundingBox, track.boundingBox);
            if (iou > this.iouMatchThreshold && iou > bestIOU) {
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
    //         if (track.className !== det.className)
    //             continue;

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
        let bestMatchId = null;
        let bestIOU = this.iouMatchThreshold;

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
            if (cost > (1 - this.iouMatchThreshold)) continue;

            const [trackId, track] = activeTrackEntries[trackIdx];
            const det = detections[detIdx];

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
            track.active = track.active || track.hits >= this.minConfirmations;
            track.movement.lastSeen = now;
            track.movement.moving = movement >= this.movementThreshold;

            if (!track.active && track.hits >= this.minConfirmations) {
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
                track.active = track.active || track.hits >= this.minConfirmations;
                track.movement.lastSeen = now;
                track.movement.moving = movement >= this.movementThreshold;

                if (!track.active && track.hits >= this.minConfirmations) {
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
                track.active = track.hits >= this.minConfirmations;
                track.lostFrames = 0;
                track.movement.lastSeen = now;
                track.movement.moving = movement >= this.movementThreshold;

                if (!track.active && track.hits >= this.minConfirmations) {
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
            this.logger.log(`New track ${newId} ${det.className} created`);

            this.tracks.set(newId, {
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
            });
            updatedTrackIds.add(newId);
        }

        return {
            assignedTracks,
            updatedTrackIds,
            newlyConfirmedIds,
        }
    }

    update(detectionsRaw: ObjectDetectionResult[]) {
        const detections = prefilterDetections({
            detections: detectionsRaw,
            iouThreshold: this.iouNmsThreshold,
            settings: this.session.settings,
        });

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

        const currentActiveIds = new Set(active.map(t => t.id));
        const sceneChanged =
            newlyConfirmedIds.size > 0 ||
            this.lastActiveIds.size === 0 && currentActiveIds.size > 0 ||
            [...this.lastActiveIds].some(id => !currentActiveIds.has(id));

        const detectionId = sceneChanged ? this.getNewDetectionId() : undefined;

        this.lastActiveIds = currentActiveIds;

        active.push(...active.map(det => ({
            boundingBox: det.boundingBox,
            className: 'motion',
            score: 1
        })));

        this.currentFrame++;

        return { active, pending, detectionId };
    }

    distance(c1: Point, c2: Point) {
        return Math.sqrt((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2);
    }

    // matchUsingIOU(det: ObjectDetectionResult) {
    //     let bestMatch = null;
    //     let bestIOU = 0;

    //     for (const [trackId, track] of this.tracks) {
    //         const iou = calculateIoU(det.boundingBox, track.boundingBox);
    //         if (iou > this.iouMatchThreshold && iou > bestIOU) {
    //             bestIOU = iou;
    //             bestMatch = trackId;
    //         }
    //     }

    //     return bestMatch;
    // }
} 