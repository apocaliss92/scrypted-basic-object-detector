import sdk, { ObjectDetectionResult, Point } from '@scrypted/sdk';
import { BoundingBox, normalizeBox } from './polygon';

export function safeParseJson(value: string) {
    try {
        return JSON.parse(value);
    }
    catch (e) {
    }
}

export function getAllDevices() {
    return Object.keys(sdk.systemManager.getSystemState()).map(id => sdk.systemManager.getDeviceById(id));
}


export function calculateIoU(box1: BoundingBox, box2: BoundingBox) {
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

export function filterDetections(detections: ObjectDetectionResult[], iouThreshold = 0.5) {
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

export const calculateCentroid = (box: BoundingBox) => {
    const [x, y, width, height] = box;
    return {
        x: x + width / 2,
        y: y + height / 2
    };
}

export const calculateDistance = (point1: Point, point2: Point) => {
    const dx = point1[0] - point2[0];
    const dy = point1[1] - point2[1];
    return Math.sqrt(dx * dx + dy * dy);
}
