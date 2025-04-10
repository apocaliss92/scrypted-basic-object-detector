import { ObjectDetectionGeneratorSession, ObjectDetectionResult, Point, VideoFrame } from "@scrypted/sdk";
import { BoundingBox, calculateIoU, filterOverlappedDetections } from "./util";
import { randomBytes } from "crypto";

interface TrackedObject extends ObjectDetectionResult {
    hits: number;
    misses: number;
    active: boolean;
}

export class ObjectTracker {
    minConfirmations: number;
    maxMisses: number;
    movementThreshold: number;
    iouMatchThreshold: number;
    iouNmsThreshold: number;
    tracks: Map<string, TrackedObject>;
    lastActiveIds: Set<string>;
    nextTrackId: number;
    logger: Console;
    session: ObjectDetectionGeneratorSession;
    sessionId = randomBytes(2).toString('hex');
    currentFrame = 0;

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
    }

    getCentroid(bbox: BoundingBox): Point {
        return [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2];
    }

    getNewDedetctionId() {
        return `${this.sessionId}-${this.currentFrame}`;
    }

    update(detectionsRaw: ObjectDetectionResult[]) {
        const now = Date.now();
        const detections = filterOverlappedDetections(detectionsRaw, this.iouNmsThreshold);
        const assignedTracks = new Set();
        const updatedTrackIds = new Set();
        const newlyConfirmedIds = new Set();
        const removedIds = new Set();

        for (const det of detections) {
            const matchId = this.matchUsingIOU(det);

            if (matchId && !assignedTracks.has(matchId)) {
                const track = this.tracks.get(matchId);
                const oldCentroid = this.getCentroid(track.boundingBox);
                const newCentroid = this.getCentroid(det.boundingBox);
                const movement = this.distance(oldCentroid, newCentroid);

                if (!track.movement) {
                    track.movement = {
                        firstSeen: undefined,
                        lastSeen: undefined,
                        moving: false,
                    };
                }

                track.boundingBox = det.boundingBox;
                track.className = det.className;
                track.score = det.score;
                track.hits++;
                track.misses = 0;
                track.active = track.active || track.hits >= this.minConfirmations;
                track.movement.lastSeen = now;
                track.movement.moving = movement >= this.movementThreshold;;

                if (!track.active && track.hits >= this.minConfirmations) {
                    track.active = true;
                    newlyConfirmedIds.add(track.id);
                }

                assignedTracks.add(matchId);
                updatedTrackIds.add(matchId);
            } else {
                const newId = (this.nextTrackId++).toString(36);
                this.tracks.set(newId, {
                    id: newId,
                    boundingBox: det.boundingBox,
                    className: det.className,
                    score: det.score,
                    label: det.label,
                    hits: 1,
                    misses: 0,
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

        // Gestione track non aggiornati
        for (const [trackId, track] of this.tracks) {
            if (!updatedTrackIds.has(trackId)) {
                track.misses++;
                if (track.misses >= this.maxMisses) {
                    if (track.active) {
                        removedIds.add(track.id);
                    }
                    this.tracks.delete(trackId);
                } else {
                    track.movement.moving = false;
                }
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

        const detectionId =
            newlyConfirmedIds.size > 0 ||
                [...this.lastActiveIds].some(id => !currentActiveIds.has(id)) ? this.getNewDedetctionId() : undefined;

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

    matchUsingIOU(det: ObjectDetectionResult) {
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
} 