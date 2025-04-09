import { ObjectDetectionResult } from '@scrypted/sdk';
import { randomBytes } from 'crypto';

export type BoundingBox = [number, number, number, number];
export interface Position {
    x: number;
    y: number;
}
export interface MovementState {
    lastPosition?: Position;
    isMoving: boolean;
    lastMovementTime: number;
}

const matchThreshold = 0.7;

export const calculateIoU = (box1: BoundingBox, box2: BoundingBox) => {
    const box1Coords = [
        box1[0],
        box1[1],
        box1[0] + box1[2],
        box1[1] + box1[3]
    ];

    const box2Coords = [
        box2[0],
        box2[1],
        box2[0] + box2[2],
        box2[1] + box2[3]
    ];

    const x1 = Math.max(box1Coords[0], box2Coords[0]);
    const y1 = Math.max(box1Coords[1], box2Coords[1]);
    const x2 = Math.min(box1Coords[2], box2Coords[2]);
    const y2 = Math.min(box1Coords[3], box2Coords[3]);

    const intersectionArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

    const box1Area = box1[2] * box1[3];  // width * height
    const box2Area = box2[2] * box2[3];  // width * height

    const unionArea = box1Area + box2Area - intersectionArea;

    return intersectionArea / unionArea;
}

export const calculateDistance = (pos1: Position, pos2: Position) => {
    return Math.sqrt(
        Math.pow(pos2.x - pos1.x, 2) +
        Math.pow(pos2.y - pos1.y, 2)
    );
}

export const detectMovement = (
    currentObj: ObjectDetectionResult,
    previousObj: ObjectDetectionResult
) => {
    if (!currentObj.boundingBox || !previousObj.boundingBox) {
        return false;
    }

    // Calculate center points
    const currentCenter = {
        x: currentObj.boundingBox[0] + currentObj.boundingBox[2] / 2,
        y: currentObj.boundingBox[1] + currentObj.boundingBox[3] / 2
    };

    const previousCenter = {
        x: previousObj.boundingBox[0] + previousObj.boundingBox[2] / 2,
        y: previousObj.boundingBox[1] + previousObj.boundingBox[3] / 2
    };

    // Calculate movement distance
    const movementDistance = Math.sqrt(
        Math.pow(currentCenter.x - previousCenter.x, 2) +
        Math.pow(currentCenter.y - previousCenter.y, 2)
    );

    // Consider movement significant if it's more than 1% of the diagonal of the bounding box
    const diagonalLength = Math.sqrt(
        Math.pow(currentObj.boundingBox[2], 2) +
        Math.pow(currentObj.boundingBox[3], 2)
    );

    return movementDistance > (diagonalLength * 0.01);
}

export const calculateSimilarity = (
    obj1: ObjectDetectionResult,
    obj2: ObjectDetectionResult
) => {
    if (!obj1.boundingBox || !obj2.boundingBox) return 0;
    if (obj1.className !== obj2.className) return 0;

    // Position similarity based on box centers
    const center1 = {
        x: obj1.boundingBox[0] + obj1.boundingBox[2] / 2,
        y: obj1.boundingBox[1] + obj1.boundingBox[3] / 2
    };
    const center2 = {
        x: obj2.boundingBox[0] + obj2.boundingBox[2] / 2,
        y: obj2.boundingBox[1] + obj2.boundingBox[3] / 2
    };

    // Calculate Euclidean distance and normalize it
    const maxDistance = Math.sqrt(
        Math.pow(obj1.boundingBox[2], 2) +
        Math.pow(obj1.boundingBox[3], 2)
    );
    const distance = Math.sqrt(
        Math.pow(center2.x - center1.x, 2) +
        Math.pow(center2.y - center1.y, 2)
    );
    const positionSimilarity = Math.max(0, 1 - (distance / maxDistance));

    return positionSimilarity
}

export const findBestMatch = (
    currentObj: ObjectDetectionResult,
    previousFrame: ObjectDetectionResult[] = []
) => {
    if (!currentObj.boundingBox || !previousFrame.length) {
        return null;
    }

    let bestMatch: ObjectDetectionResult | null = null;
    let bestSimilarity = -1;

    for (const prevObj of previousFrame) {
        if (!prevObj.boundingBox) continue;

        const similarity = calculateSimilarity(currentObj, prevObj);

        if (similarity > bestSimilarity && similarity >= matchThreshold) {
            bestMatch = prevObj;
            bestSimilarity = similarity;
        }
    }

    return bestMatch;
}

export class SessionManager {
    sessionId: string;

    constructor(sessionId = randomBytes(2).toString("hex")) {
        this.sessionId = sessionId
    }

    createDetectionId(e, t) {
        t = t ? `-${t}` : "";
        return `${this.sessionId}${t}-${e}`
    }
}

interface TrackDetection extends ObjectDetectionResult {
    missCount: number;
}

export class Tracker {
    iouThreshold: number;
    maxMisses: number;
    tracks: TrackDetection[];
    trackCount = 0;

    constructor(iouThreshold = 0.5, maxMisses = 3) {
        this.iouThreshold = iouThreshold;
        this.maxMisses = maxMisses;
        this.tracks = [];
    }

    resetTrackCount() {
        this.trackCount = 0;
    }

    update(detections: ObjectDetectionResult[]) {
        const updatedTracks = [];

        for (const detection of detections) {
            let bestMatch = null;
            let bestIoU = this.iouThreshold;

            for (const track of this.tracks) {
                if (track.className !== detection.className) continue;

                const iou = calculateIoU(detection.boundingBox, track.boundingBox);
                if (iou > bestIoU) {
                    bestIoU = iou;
                    bestMatch = track;
                }
            }

            if (bestMatch) {
                // Update existing track
                bestMatch.boundingBox = detection.boundingBox;
                bestMatch.score = detection.score;
                bestMatch.missCount = 0;
                updatedTracks.push(bestMatch);
            } else {
                // Create new track
                const newTrack = {
                    id: this.trackCount++,
                    boundingBox: detection.boundingBox,
                    classname: detection.className,
                    score: detection.score,
                    missCount: 0,
                };
                updatedTracks.push(newTrack);
            }
        }

        // Increment miss count for unmatched old tracks
        for (const track of this.tracks) {
            if (!updatedTracks.some(t => t.id === track.id)) {
                track.missCount++;
                if (track.missCount <= this.maxMisses) {
                    updatedTracks.push(track);
                }
            }
        }

        this.tracks = updatedTracks;

        return this.tracks;
    }
}

export function filterOverlappedDetections(detections: ObjectDetectionResult[], iouThreshold = 0.5) {
    if (!detections || detections.length === 0) return [];

    const sortedDetections = [...detections].sort((a, b) => b.score - a.score);
    const selectedDetections = [];

    while (sortedDetections.length > 0) {
        const currentDetection = sortedDetections.shift();
        selectedDetections.push(currentDetection);

        const remaining = sortedDetections.filter(detection => {
            if (detection.className !== currentDetection.className) return true;

            const iou = calculateIoU(
                currentDetection.boundingBox,
                detection.boundingBox
            );
            return iou <= iouThreshold;
        });

        sortedDetections.length = 0;
        sortedDetections.push(...remaining);
    }

    return selectedDetections;
}
// export const filterOverlappedDetections = (detections: ObjectDetectionResult[], iouThreshold = 0.5) => {
//     if (!detections || detections.length === 0) return [];

//     const sortedDetections = [...detections].sort((a, b) => b.score - a.score);
//     const selectedDetections = [];

//     while (sortedDetections.length > 0) {
//         const currentDetection = sortedDetections.shift();
//         selectedDetections.push(currentDetection);

//         const remaining = sortedDetections.filter(detection => {
//             if (detection.className !== currentDetection.className) return true;

//             const iou = calculateIoU(
//                 currentDetection.boundingBox,
//                 detection.boundingBox
//             );
//             return iou <= iouThreshold;
//         });

//         sortedDetections.length = 0;
//         sortedDetections.push(...remaining);
//     }

//     return selectedDetections;
// }