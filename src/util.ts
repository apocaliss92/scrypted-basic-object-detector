import { ObjectDetectionGeneratorSession, ObjectDetectionResult } from '@scrypted/sdk';

export type BoundingBox = [number, number, number, number];

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

export const filterOverlappedDetections = (detections: ObjectDetectionResult[], iouThreshold = 0.5) => {
    if (!detections || detections.length === 0) return [];

    const sortedDetections = [...detections].sort((a, b) => b.score - a.score);
    const selectedDetections: ObjectDetectionResult[] = [];

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

const filterBySettings = (detections: ObjectDetectionResult[], settings: any) => {
    if (!detections || detections.length === 0) return [];

    if (!settings) {
        return detections;
    }

    const enabledClasses = settings?.enabledClasses;
    return detections.filter(det => {
        const className = det.className;
        if (!enabledClasses.includes(className)) {
            return false;
        }

        const scoreThreshold = settings[`${className}-minScore`];

        if (!scoreThreshold) {
            return true;
        }

        if (det.score < scoreThreshold) {
            return false
        }

        return true;
    })
}

export const prefilterDetections = (props: {
    detections: ObjectDetectionResult[],
    settings: ObjectDetectionGeneratorSession['settings'],
    iouThreshold?: number
}) => {
    const { detections, settings, iouThreshold = 0.5 } = props;

    return filterOverlappedDetections(
        filterBySettings(detections, settings),
        iouThreshold
    );
}