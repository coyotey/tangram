import Label from './label';
import Vector from '../vector';
import OBB from '../utils/obb';

const PLACEMENT = {
    MID_POINT: 0,
    CORNER: 1
};

const MAX_ANGLE = Math.PI / 2;      // maximum angle for articulated labels
const LINE_EXCEED_STRAIGHT = .1;   // minimal ratio for straight labels (label length) / (line length)
const LINE_EXCEED_KINKED = 0.6;     // minimal ratio for kinked labels

export default class LabelLine {

    constructor (size, lines, layout) {
        this.size = size;
        this.layout = layout;
        this.lines = lines;
        this.space_width = layout.space_width; // width of space for the font used
        this.space_indices = layout.space_indices;
        this.num_segments = size.length; // number of label segments
        this.total_length = size.reduce(function(prev, next){ return prev + next[0]; }, 0) + this.space_indices.length * this.space_width;
        this.total_height = size[0][1];
        this.placement = (layout.placement === undefined) ? PLACEMENT.MID_POINT : layout.placement;

        this.kink_index = 0; // index at which an articulated label will kink (e.g., 1 means a kink _after_ the first segment)
        this.spread_factor = 1; // spaces out adjacent words to prevent overlap
        this.fitness = 0; // measure of quality of fit

        this.line_lengths = getLineLengths(lines);
        this.line_angles = getLineAngles(lines);

        // Arrays for Label properties. TODO: create array of Label types, where LabelLine acts as a "grouped label"
        this.position = [];
        this.angle = [];
        this.offsets = [];
        this.obbs = [];
        this.aabbs = [];

        // optionally limit the line segments that the label may be placed in, by specifying a segment index range
        // used as a coarse subdivide for placing multiple labels per line geometry
        this.segment_index = layout.segment_index || layout.segment_start || 0;
        this.segment_max = layout.segment_end || this.lines.length;

        let spacing = 50;
        let result = getStartingPositions(lines, spacing + this.total_length, layout.units_per_pixel);
        let label_positions = result.positions;
        let indices = result.indices;

        if (label_positions.length === 0){
            this.throw_away = true;
            return;
        }

        for (let i = 0; i < label_positions.length; i++){
            // only do first one for now
            if (i !== 0 ) return;

            let index = indices[i];
            let line_position = lines[index];
            let label_position = label_positions[i];

            let offset = [
                label_position[0] - line_position[0],
                label_position[1] - line_position[1]
            ];

            let {positions, offsets, angles, widths} = placeAtPosition.call(this, lines, this.line_lengths, this.size, index, offset);
            let {obbs, aabbs} = createBoundingBoxes(positions, angles, widths);

            this.position = positions;
            this.offsets = offsets;
            this.angle = angles;
            this.obbs = obbs;
            this.aabbs = aabbs;
        }

        // First fitting segment
        // let segment = this.getNextFittingSegment(this.getCurrentSegment());
        // this.throw_away = (!segment);
    }

    // Iterate through the line geometry creating the next valid label.
    static nextLabel(label) {
        // increment segment
        let hasNext = label.getNextSegment();
        if (!hasNext) {
            return false;
        }

        // clone options
        let layout = Object.create(label.layout);
        layout.segment_index = label.segment_index;
        layout.placement = label.placement;

        // create new label
        let nextLabel = new LabelLine(label.size, label.lines, layout);

        return (nextLabel.throw_away) ? false : nextLabel;
    }

    fit (line){
        let length = getLineLength(line);
        let spacing = 50;

        for (let i = 0; i < line.length; i++){
            let segment = line[i];
        }
    }

    // Strategy for returning the next segment. Assumes an "ordering" of possible segments
    // taking into account both straight and articulated segments. Returns false if all possibilities
    // have been exhausted
    getNextSegment() {
        switch (this.placement) {
            case PLACEMENT.CORNER:
                this.placement = PLACEMENT.MID_POINT;
                break;
            case PLACEMENT.MID_POINT:
                if (this.segment_index >= this.lines.length - 2) {
                    return false;
                }
                else if (this.size.length > 1) {
                    this.placement = PLACEMENT.CORNER;
                }
                this.segment_index++;
                break;
        }

        return this.getCurrentSegment();
    }

    // Returns the line segments necessary for other calculations at the current line segment index.
    // This is the current and next segment for a straight line, and the previous, current and next
    // for an articulated segment.
    getCurrentSegment() {
        let p1, p2, segment;
        switch (this.placement) {
            case PLACEMENT.CORNER:
                p1 = this.lines[this.segment_index - 1];
                p2 = this.lines[this.segment_index];
                let p3 = this.lines[this.segment_index + 1];
                segment = [ p1, p2, p3 ];
                break;
            case PLACEMENT.MID_POINT:
                p1 = this.lines[this.segment_index];
                p2 = this.lines[this.segment_index + 1];
                segment = [ p1, p2 ];
                break;
        }

        return segment;
    }

    // Returns next segment that is valid (within tile, inside angle requirements and within line geometry).
    getNextFittingSegment(segment) {
        segment = segment || this.getNextSegment();
        if (!segment) {
            return false;
        }

        if (this.doesSegmentFit(segment)) {
            this.update();
            if (this.inTileBounds() && this.inAngleBounds()) {
                return segment;
            }
        }

        return this.getNextFittingSegment();
    }

    // Returns boolean indicating whether current segment is valid
    doesSegmentFit(segment) {
        switch (this.placement) {
            case PLACEMENT.CORNER:
                return this.fitKinkedSegment(segment);
            case PLACEMENT.MID_POINT:
                return this.fitStraightSegment(segment);
        }
    }

    // Returns boolean indicating whether kinked segment is valid
    // Cycles through various ways of kinking the labels around the segment's pivot,
    // finding the best fit, and determines the kink_index.
    fitKinkedSegment(segment) {
        let upp = this.layout.units_per_pixel;

        let p0p1 = Vector.sub(segment[0], segment[1]);
        let p1p2 = Vector.sub(segment[1], segment[2]);

        // Don't fit if segment doesn't pass the vertical line test, resulting in upside-down labels
        if (p0p1[0] * p1p2[0] < 0 && p0p1[1] * p1p2[1] > 0) {
            return false;
        }

        let line_length1 = Vector.length(p0p1) / upp;
        let line_length2 = Vector.length(p1p2) / upp;

        // break up multiple segments into two chunks (N-1 options)
        let label_length1 = this.total_length;
        let label_length2 = 0;
        let width, fitness = 0;
        let kink_index = this.num_segments - 1;
        let fitnesses = [];

        while (kink_index > 0) {
            width = this.size[kink_index][0];

            if (hasSpaceAtIndex(kink_index, this.space_indices)){
                width += this.space_width;
            }

            label_length1 -= width;
            label_length2 += width;

            fitness = Math.max(calcFitness(line_length1, label_length1), calcFitness(line_length2, label_length2));
            fitnesses.unshift(fitness);

            kink_index--;
        }

        let max_fitness = Math.max.apply(null, fitnesses);

        if (max_fitness < LINE_EXCEED_KINKED) {
            this.kink_index = fitnesses.indexOf(max_fitness) + 1;
            this.fitness = max_fitness;
            return true;
        }
        else {
            this.kink_index = 0;
            return false;
        }
    }

    // Returns boolean indicating whether straight segment is valid
    // A straight segment is placed at the midpoint and is valid if the label's length is greater than a
    // factor (LINE_EXCEED_STRAIGHT) of the line segment's length
    fitStraightSegment(segment) {
        let upp = this.layout.units_per_pixel;
        let line_length = Vector.length(Vector.sub(segment[0], segment[1])) / upp;
        let fitness = calcFitness(line_length, this.total_length);

        if (fitness < LINE_EXCEED_STRAIGHT){
            this.fitness = fitness;
            return true;
        }
        else {
            return false;
        }
    }

    // Once a fitting segment is found, determine its angles, positions and bounding boxes
    update() {
        this.angle = this.getCurrentAngle();
        this.position = this.getCurrentPosition();
        this.updateBBoxes();
    }

    getCurrentAngle() {
        let segment = this.getCurrentSegment();
        let angles = [];

        switch (this.placement) {
            case PLACEMENT.CORNER:
                let theta1 = getAngleFromSegment(segment[0], segment[1]);
                let theta2 = getAngleFromSegment(segment[1], segment[2]);

                let p0p1 = Vector.sub(segment[0], segment[1]);
                let p1p2 = Vector.sub(segment[1], segment[2]);

                let orientation = (p0p1[0] >= 0 && p1p2[0] >= 0) ? 1 : -1;
                let angle;

                for (let i = 0; i < this.num_segments; i++){
                    if (i < this.kink_index){
                        angle = (orientation > 0) ? theta2 : theta1;
                    }
                    else {
                        angle = (orientation > 0) ? theta1 : theta2;
                    }
                    angles.push(angle);
                }
                break;
            case PLACEMENT.MID_POINT:
                let theta = getAngleFromSegment(segment[0], segment[1]);
                for (let i = 0; i < this.num_segments; i++){
                    angles.push(theta);
                }
                break;
        }

        return angles;
    }

    // Return the position of the center of the label
    getCurrentPosition() {
        let segment = this.getCurrentSegment();
        let position;

        switch (this.placement) {
            case PLACEMENT.CORNER:
                position = segment[1].slice();
                break;
            case PLACEMENT.MID_POINT:
                position = [
                    0.5 * (segment[0][0] + segment[1][0]),
                    0.5 * (segment[0][1] + segment[1][1])
                ];
                break;
        }

        return position;
    }

    // Check for articulated labels to be within an angle range [-MAX_ANGLE, +MAX_ANGLE]
    inAngleBounds() {
        switch (this.placement) {
            case PLACEMENT.CORNER:
                let angle0 = this.angle[0];
                if (angle0 < 0) {
                    angle0 += 2 * Math.PI;
                }

                let angle1 = this.angle[1];
                if (angle1 < 0) {
                    angle1 += 2 * Math.PI;
                }

                let theta = Math.abs(angle1 - angle0);
                theta = Math.min(2 * Math.PI - theta, theta);

                return theta <= MAX_ANGLE;
            case PLACEMENT.MID_POINT:
                return true;
        }
    }

    // Calculate bounding boxes
    updateBBoxes() {
        let upp = this.layout.units_per_pixel;
        let height = (this.total_height + this.layout.buffer[1] * 2) * upp * Label.epsilon;

        // reset bounding boxes
        this.obbs = [];
        this.aabbs = [];

        switch (this.placement) {
            case PLACEMENT.CORNER:
                let angle0 = this.angle[this.kink_index - 1]; // angle before kink
                let angle1 = this.angle[this.kink_index]; // angle after kink
                let theta = Math.abs(angle1 - angle0); // angle delta

                // A spread factor of 0 pivots the boxes on their horizontal center, looking like: "X"
                // a spread factor of 1 offsets the boxes so that their corners touch, looking like: "\/" or "/\"
                let dx = this.spread_factor * Math.abs(this.total_height * Math.tan(0.5 * theta));
                let nudge = -0.5 * dx;

                if (hasSpaceAtIndex(this.kink_index, this.space_indices)){
                    nudge -= 0.5 * this.space_width;
                }

                // Place labels backwards from kink index
                for (let i = this.kink_index - 1; i >= 0; i--) {
                    let width_px = this.size[i][0];
                    let angle = this.angle[i];

                    let width = (width_px + 2 * this.layout.buffer[0]) * upp * Label.epsilon;

                    nudge -= 0.5 * width_px;

                    let offset = Vector.rot([nudge * upp, 0], -angle);
                    let position = Vector.add(this.position, offset);

                    let obb = getOBB(position, width, height, angle, this.offset, upp);
                    let aabb = obb.getExtent();

                    this.obbs.push(obb);
                    this.aabbs.push(aabb);

                    this.offsets[i] = [
                        this.layout.offset[0] + nudge,
                        this.layout.offset[1]
                    ];

                    nudge -= 0.5 * width_px;

                    if (hasSpaceAtIndex(this.kink_index, this.space_indices)){
                       nudge -= 0.5 * this.space_width;
                    }
                }

                // Place labels forwards from kink index
                nudge = 0.5 * dx;

                if (hasSpaceAtIndex(this.kink_index, this.space_indices)){
                    nudge += 0.5 * this.space_width;
                }

                for (let i = this.kink_index; i < this.num_segments; i++){
                    let width_px = this.size[i][0];
                    let angle = this.angle[i];

                    let width = (width_px + 2 * this.layout.buffer[0]) * upp * Label.epsilon;

                    nudge += 0.5 * width_px;

                    let offset = Vector.rot([nudge * upp, 0], -angle);
                    let position = Vector.add(this.position, offset);

                    let obb = getOBB(position, width, height, angle, this.offset, upp);
                    let aabb = obb.getExtent();

                    this.obbs.push(obb);
                    this.aabbs.push(aabb);

                    this.offsets[i] = [
                        this.layout.offset[0] + nudge,
                        this.layout.offset[1]
                    ];

                    nudge += 0.5 * width_px;

                    if (hasSpaceAtIndex(this.kink_index, this.space_indices)){
                        nudge += 0.5 * this.space_width;
                    }
                }
                break;
            case PLACEMENT.MID_POINT:
                let shift = -0.5 * this.total_length; // shift for centering the labels

                for (let i = 0; i < this.num_segments; i++){
                    if (hasSpaceAtIndex(i, this.space_indices)){
                        shift += 0.5 * this.space_width;
                    }

                    let width_px = this.size[i][0];
                    let width = (width_px + 2 * this.layout.buffer[0]) * upp * Label.epsilon;
                    let angle = this.angle[i];

                    shift += 0.5 * width_px;

                    let offset = Vector.rot([shift * upp, 0], -angle);
                    let position = Vector.add(this.position, offset);

                    let obb = getOBB(position, width, height, angle, this.offset, upp);
                    let aabb = obb.getExtent();

                    this.obbs.push(obb);
                    this.aabbs.push(aabb);

                    this.offsets[i] = [
                        this.layout.offset[0] + shift,
                        this.layout.offset[1]
                    ];

                    shift += 0.5 * width_px;
                }

                break;
        }
    }

    // Checks each segment to see if it is within the tile. If any segment fails this test, they all fail.
    // TODO: label group
    inTileBounds() {
        for (let i = 0; i < this.aabbs.length; i++) {
            let aabb = this.aabbs[i];
            let obj = { aabb };
            let in_bounds = Label.prototype.inTileBounds.call(obj);
            if (!in_bounds) {
                return false;
            }
        }
        return true;
    }

    // Adds each segment to the collision pass as its own bounding box
    // TODO: label group
    add(bboxes) {
        this.placed = true;
        for (let i = 0; i < this.aabbs.length; i++) {
            let aabb = this.aabbs[i];
            let obb = this.obbs[i];
            let obj = { aabb, obb };
            Label.prototype.add.call(obj, bboxes);
        }
    }

    // Checks each segment to see if it should be discarded (via collision). If any segment fails this test, they all fail.
    // TODO: label group
    discard(bboxes, exclude = null) {
        if (this.throw_away) {
            return true;
        }

        for (let i = 0; i < this.obbs.length; i++){
            let aabb = this.aabbs[i];
            let obb = this.obbs[i];
            let obj = { aabb, obb };

            let shouldDiscard = Label.prototype.occluded.call(obj, bboxes, exclude);
            if (shouldDiscard) {
                return true;
            }
        }
        return false;
    }
}

// Private method to calculate oriented bounding box
function getOBB(position, width, height, angle, offset, upp) {
    let p0, p1;
    // apply offset, x positive, y pointing down
    if (offset && (offset[0] !== 0 || offset[1] !== 0)) {
        offset = Vector.rot(offset, angle);
        p0 = position[0] + (offset[0] * upp);
        p1 = position[1] - (offset[1] * upp);
    }
    else {
        p0 = position[0];
        p1 = position[1];
    }

    // the angle of the obb is negative since it's the tile system y axis is pointing down
    return new OBB(p0, p1, -angle, width, height);
}

// Private method to calculate the angle of a segment.
// Transforms the angle to lie within the range [0, PI/2] and [3*PI/2, 2*PI] (1st or 4th quadrants)
// as other ranges produce "upside down" labels
function getAngleFromSegment(pt1, pt2) {
    let PI = Math.PI;
    let PI_2 = PI / 2;
    let p1p2 = Vector.sub(pt1, pt2);
    let theta = Math.atan2(p1p2[0], p1p2[1]) + PI_2;

    if (theta > PI_2) {
        // If in 2nd quadrant, move to 4th quadrant
        theta += PI;
        theta %= 2 * Math.PI;
    }
    else if (theta < 0) {
        // If in 4th quadrant, make a positive angle
        theta += 2 * PI;
    }

    return theta;
}

function calcFitness(line_length, label_length) {
    return 1 - line_length / label_length;
}

function hasSpaceAtIndex(index, space_indices) {
    return (space_indices.indexOf(index) !== -1);
}

function getLineLength(line){
    let distance = 0;
    for (let i = 0; i < line.length - 1; i++){
        distance += norm(line[i], line[i+1]);
    }
    return distance;
}

function norm(p, q){
    return Math.sqrt(Math.pow(p[0] - q[0], 2) + Math.pow(p[1] - q[1], 2));
}

function getStartingPositions(line, spacing, upp){
    let length = getLineLength(line);
    let num_labels = Math.floor(length / spacing);
    let remainder = length - (num_labels - 1) * spacing;

    let positions = [];
    let indices = [];

    let distance = 0.5 * remainder;
    for (let i = 0; i < num_labels; i++){
        let result = interpolateLine(line, distance);
        let position = result.position;
        let index = result.index;

        positions.push(position);
        indices.push(index);
        distance += spacing;
    }

    return {positions, indices};
}

function interpolateLine(line, distance){
    let sum = 0;
    for (let i = 0; i < line.length - 1; i++){
        let prevSum = sum
        let p = line[i];
        let q = line[i+1];
        let segment_length = norm(p, q);

        sum += segment_length;

        if (sum > distance){
            let overflow = sum - distance;
            let position = interpolateSegment(p, q, overflow);
            let index = i; // super weird
            return {position, index};
        }
    }
}

function interpolateAngle(index, ratio){
    let angle1 = this.line_angles[index];
    let angle2 = this.line_angles[index + 1];
    return interpolate1d(angle1, angle2, ratio);
}

function interpolateSegment(p, q, distance){
    let length = norm(p, q);
    let ratio = distance / length;
    return interpolate2d(p, q, ratio);
}

function interpolate1d(x, y, t){
     return t * x + (1 - t) * y
}

function interpolate2d(x, y, t){
     return [
         interpolate1d(x[0], y[0], t),
         interpolate1d(x[1], y[1], t)
     ];
}

function placeAtPosition(line, line_lengths, sizes, index, index_offset){
    let positions = [];
    let offsets = [];
    let angles = [];
    let widths = [];

    let position = [
        line[index][0] + index_offset[0],
        line[index][1] + index_offset[1]
    ];

    let offset = [0, 0];

    let length = Math.sqrt(offset[0]*offset[0] + offset[1]*offset[1]);
    let segment_length = line_lengths[index];

    for (let i = 0; i < sizes.length; i++){
        while (length > segment_length){
            index++;
            length = length - segment_length;
            segment_length = line_lengths[index];
        }

        let segment_width = sizes[i][0];
        let ratio = length / segment_length;
        let angle = interpolateAngle.call(this, index, ratio);
        let segment_offset = Vector.rot([0.5 * segment_width, 0], angle);

        position = Vector.add(position, segment_offset);
        offset = Vector.add(offset, segment_offset);

        positions.push(position);
        offsets.push(offset);
        angles.push(angle);
        widths.push(segment_width);

        position = Vector.add(position, segment_offset);
        length += segment_length;
    }

    return {positions, offsets, angles, widths};
}

function createBoundingBoxes(positions, angles, widths, height){
    let obbs = [];
    let aabbs = [];
    for (let i = 0; i < positions.length; i++){
        let obb = getOBB(positions[i], widths[i], height, angles[i]);
        let aabb = obb.getExtent();

        obbs.push(obb);
        aabbs.push(aabb);
    }
    return {obbs, aabbs};
}

function getLineAngles(line){
    let angles = [];
    for (let i = 0; i < line.length - 1; i++){
        let p = line[i];
        let q = line[i+1];
        let angle = Math.atan2(q[0] - p[0], q[1] - p[1]);
        angles.push(angle);
    }
    return angles;
}

function getLineLengths(line){
    let lengths = [];
    for (let i = 0; i < line.length - 1; i++){
        let p = line[i];
        let q = line[i+1];
        let length = norm(p,q);
        lengths.push(length);
    }
    return lengths;
}