import sdk, { ObjectDetectionResult } from '@scrypted/sdk';
import { BoundingBox } from './polygon';

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


const calculateIoU = (box1: BoundingBox, box2: BoundingBox) => {
    const x1 = Math.max(box1[0], box2[0]);
    const y1 = Math.max(box1[1], box2[1]);
    const x2 = Math.min(box1[2], box2[2]);
    const y2 = Math.min(box1[3], box2[3]);

    const intersectionArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

    const box1Area = (box1[2] - box1[0]) * (box1[3] - box1[1]);
    const box2Area = (box2[2] - box2[0]) * (box2[3] - box2[1]);

    const unionArea = box1Area + box2Area - intersectionArea;

    return intersectionArea / unionArea;
}

export const nonMaxSuppression = (detections: ObjectDetectionResult[], iouThreshold = 0.2) => {
    const indices = detections.map((_, idx) => idx);
    indices.sort((a, b) => detections[b].score - detections[a].score);

    const selectedIndices = [];

    while (indices.length > 0) {
        const currentIdx = indices[0];
        selectedIndices.push(currentIdx);

        const remaining = [];
        for (let i = 1; i < indices.length; i++) {
            const idx = indices[i];
            const iou = calculateIoU(detections[currentIdx].boundingBox, detections[idx].boundingBox);
            if (iou <= iouThreshold) {
                remaining.push(idx);
            }
        }

        indices.length = 0;
        indices.push(...remaining);
    }

    return selectedIndices.map(idx => detections[idx]);
}