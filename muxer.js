// Lightweight fMP4 muxer for combining separate video and audio tracks
// Specifically designed for Vimeo DASH segments (CMAF/fMP4 format)

// ===== MP4 Box Parser =====

function readUint32(data, offset) {
  return (data[offset] << 24) | (data[offset + 1] << 16) |
         (data[offset + 2] << 8) | data[offset + 3];
}

function writeUint32(data, offset, value) {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function readUint16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function writeUint16(data, offset, value) {
  data[offset] = (value >>> 8) & 0xff;
  data[offset + 1] = value & 0xff;
}

function boxType(data, offset) {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function makeBox(type, content) {
  const size = 8 + content.length;
  const box = new Uint8Array(size);
  writeUint32(box, 0, size);
  box[4] = type.charCodeAt(0);
  box[5] = type.charCodeAt(1);
  box[6] = type.charCodeAt(2);
  box[7] = type.charCodeAt(3);
  box.set(content, 8);
  return box;
}

// Parse top-level boxes from an MP4 buffer
function parseBoxes(data) {
  const boxes = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + 8 > data.length) break;
    let size = readUint32(data, offset);
    const type = boxType(data, offset + 4);

    if (size === 0) {
      size = data.length - offset;
    } else if (size === 1) {
      // 64-bit size - read next 8 bytes
      // For simplicity, handle the common case
      if (offset + 16 > data.length) break;
      // Just use the lower 32 bits (files < 4GB)
      size = readUint32(data, offset + 12);
    }

    if (size < 8 || offset + size > data.length) break;

    boxes.push({
      type,
      offset,
      size,
      data: data.subarray(offset, offset + size),
    });

    offset += size;
  }
  return boxes;
}

// Parse child boxes inside a container box
function parseChildBoxes(parentData) {
  // Skip the 8-byte header of the parent
  const inner = parentData.subarray(8);
  const children = [];
  let offset = 0;
  while (offset < inner.length) {
    if (offset + 8 > inner.length) break;
    let size = readUint32(inner, offset);
    const type = boxType(inner, offset + 4);
    if (size === 0) size = inner.length - offset;
    if (size < 8 || offset + size > inner.length) break;
    children.push({
      type,
      offset,
      size,
      data: inner.subarray(offset, offset + size),
    });
    offset += size;
  }
  return children;
}

// Find a box by type in a list
function findBox(boxes, type) {
  return boxes.find(b => b.type === type);
}

// Find all boxes of a type
function findAllBoxes(boxes, type) {
  return boxes.filter(b => b.type === type);
}

// Get the track ID from a tkhd box
function getTkhdTrackId(tkhdData) {
  // tkhd: 8 byte header + 1 byte version + 3 bytes flags + ...
  const version = tkhdData[8];
  if (version === 0) {
    // creation_time(4) + mod_time(4) + track_id(4)
    return readUint32(tkhdData, 8 + 4 + 4 + 4);
  } else {
    // creation_time(8) + mod_time(8) + track_id(4)
    return readUint32(tkhdData, 8 + 4 + 8 + 8);
  }
}

// Set the track ID in a tkhd box
function setTkhdTrackId(tkhdData, newId) {
  const version = tkhdData[8];
  if (version === 0) {
    writeUint32(tkhdData, 8 + 4 + 4 + 4, newId);
  } else {
    writeUint32(tkhdData, 8 + 4 + 8 + 8, newId);
  }
}

// Update track_id in tfhd (inside moof > traf > tfhd)
function updateMoofTrackId(moofData, newTrackId) {
  const result = new Uint8Array(moofData.length);
  result.set(moofData);

  // Parse moof children
  const moofChildren = parseChildBoxes(result);
  for (const child of moofChildren) {
    if (child.type === 'traf') {
      // Parse traf children
      const trafInner = result.subarray(8 + child.offset + 8);
      let trafOffset = 0;
      while (trafOffset < trafInner.length) {
        if (trafOffset + 8 > trafInner.length) break;
        const boxSize = readUint32(trafInner, trafOffset);
        const boxTypeName = boxType(trafInner, trafOffset + 4);
        if (boxSize < 8) break;

        if (boxTypeName === 'tfhd') {
          // tfhd: header(8) + version(1) + flags(3) + track_id(4)
          const tfhdStart = 8 + child.offset + 8 + trafOffset;
          writeUint32(result, tfhdStart + 8 + 4, newTrackId);
        }

        trafOffset += boxSize;
        if (trafOffset <= 0) break;
      }
    }
  }
  return result;
}

// Update next_track_id in mvhd
function updateMvhdNextTrackId(mvhdData, nextTrackId) {
  const result = new Uint8Array(mvhdData.length);
  result.set(mvhdData);
  const version = result[8];
  let offset;
  if (version === 0) {
    // header(8) + version+flags(4) + creation(4) + mod(4) + timescale(4) + duration(4)
    // + rate(4) + volume(2) + reserved(10) + matrix(36) + predefined(24) + next_track_id(4)
    offset = 8 + 4 + 4 + 4 + 4 + 4 + 4 + 2 + 10 + 36 + 24;
  } else {
    // header(8) + version+flags(4) + creation(8) + mod(8) + timescale(4) + duration(8)
    // + rate(4) + volume(2) + reserved(10) + matrix(36) + predefined(24) + next_track_id(4)
    offset = 8 + 4 + 8 + 8 + 4 + 8 + 4 + 2 + 10 + 36 + 24;
  }
  writeUint32(result, offset, nextTrackId);
  return result;
}

// Update track_id in trex
function updateTrexTrackId(trexData, newTrackId) {
  const result = new Uint8Array(trexData.length);
  result.set(trexData);
  // trex: header(8) + version+flags(4) + track_id(4)
  writeUint32(result, 8 + 4, newTrackId);
  return result;
}

// Concatenate multiple Uint8Arrays
function concatBuffers(...arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Build a container box from child arrays
function buildContainerBox(type, ...children) {
  const content = concatBuffers(...children);
  return makeBox(type, content);
}

// ===== Main Mux Function =====

function muxFmp4(videoBuffer, audioBuffer) {
  const videoData = new Uint8Array(videoBuffer);
  const audioData = new Uint8Array(audioBuffer);

  console.log('[Muxer] Parsing video boxes...');
  const videoBoxes = parseBoxes(videoData);
  console.log('[Muxer] Parsing audio boxes...');
  const audioBoxes = parseBoxes(audioData);

  // Extract key boxes
  const videoFtyp = findBox(videoBoxes, 'ftyp');
  const videoMoov = findBox(videoBoxes, 'moov');
  const audioMoov = findBox(audioBoxes, 'moov');

  if (!videoFtyp || !videoMoov || !audioMoov) {
    throw new Error('Missing required boxes (ftyp/moov)');
  }

  // Parse moov children
  const videoMoovChildren = parseChildBoxes(videoMoov.data);
  const audioMoovChildren = parseChildBoxes(audioMoov.data);

  // Get video trak and audio trak
  const videoTrak = findBox(videoMoovChildren, 'trak');
  const audioTrak = findBox(audioMoovChildren, 'trak');
  const videoMvhd = findBox(videoMoovChildren, 'mvhd');
  const videoMvex = findBox(videoMoovChildren, 'mvex');
  const audioMvex = findBox(audioMoovChildren, 'mvex');

  if (!videoTrak || !audioTrak || !videoMvhd) {
    throw new Error('Missing trak or mvhd boxes');
  }

  // Video track ID = 1, Audio track ID = 2
  const VIDEO_TRACK_ID = 1;
  const AUDIO_TRACK_ID = 2;

  // Update video trak: ensure track_id = 1
  const videoTrakData = new Uint8Array(videoTrak.data.length);
  videoTrakData.set(videoTrak.data);
  const videoTrakChildren = parseChildBoxes(videoTrakData);
  const videoTkhd = findBox(videoTrakChildren, 'tkhd');
  if (videoTkhd) {
    setTkhdTrackId(videoTrakData.subarray(8 + videoTkhd.offset), VIDEO_TRACK_ID);
  }

  // Update audio trak: set track_id = 2
  const audioTrakData = new Uint8Array(audioTrak.data.length);
  audioTrakData.set(audioTrak.data);
  const audioTrakChildren = parseChildBoxes(audioTrakData);
  const audioTkhd = findBox(audioTrakChildren, 'tkhd');
  if (audioTkhd) {
    setTkhdTrackId(audioTrakData.subarray(8 + audioTkhd.offset), AUDIO_TRACK_ID);
  }

  // Update mvhd next_track_id = 3
  const mvhdData = updateMvhdNextTrackId(videoMvhd.data, 3);

  // Build mvex with trex for both tracks
  let videoTrexData, audioTrexData;

  if (videoMvex) {
    const videoMvexChildren = parseChildBoxes(videoMvex.data);
    const videoTrex = findBox(videoMvexChildren, 'trex');
    if (videoTrex) {
      videoTrexData = updateTrexTrackId(videoTrex.data, VIDEO_TRACK_ID);
    }
  }
  if (!videoTrexData) {
    // Create default trex for video
    const trexContent = new Uint8Array(24);
    writeUint32(trexContent, 4, VIDEO_TRACK_ID); // track_id
    writeUint32(trexContent, 8, 1);  // default_sample_description_index
    videoTrexData = makeBox('trex', trexContent);
  }

  if (audioMvex) {
    const audioMvexChildren = parseChildBoxes(audioMvex.data);
    const audioTrex = findBox(audioMvexChildren, 'trex');
    if (audioTrex) {
      audioTrexData = updateTrexTrackId(audioTrex.data, AUDIO_TRACK_ID);
    }
  }
  if (!audioTrexData) {
    // Create default trex for audio
    const trexContent = new Uint8Array(24);
    writeUint32(trexContent, 4, AUDIO_TRACK_ID); // track_id
    writeUint32(trexContent, 8, 1);  // default_sample_description_index
    audioTrexData = makeBox('trex', trexContent);
  }

  const mvexBox = buildContainerBox('mvex', videoTrexData, audioTrexData);

  // Build new moov: mvhd + video_trak + audio_trak + mvex
  const moovBox = buildContainerBox('moov', mvhdData, videoTrakData, audioTrakData, mvexBox);

  console.log('[Muxer] Built moov box:', moovBox.length, 'bytes');

  // Collect video moof+mdat pairs and update track_id
  const videoFragments = [];
  for (const box of videoBoxes) {
    if (box.type === 'moof') {
      videoFragments.push(updateMoofTrackId(box.data, VIDEO_TRACK_ID));
    } else if (box.type === 'mdat') {
      videoFragments.push(new Uint8Array(box.data));
    }
  }

  // Collect audio moof+mdat pairs and update track_id
  const audioFragments = [];
  for (const box of audioBoxes) {
    if (box.type === 'moof') {
      audioFragments.push(updateMoofTrackId(box.data, AUDIO_TRACK_ID));
    } else if (box.type === 'mdat') {
      audioFragments.push(new Uint8Array(box.data));
    }
  }

  console.log(`[Muxer] Video fragments: ${videoFragments.length / 2} moof+mdat pairs`);
  console.log(`[Muxer] Audio fragments: ${audioFragments.length / 2} moof+mdat pairs`);

  // Assemble final file: ftyp + moov + video_fragments + audio_fragments
  const ftypData = new Uint8Array(videoFtyp.data);
  const allParts = [ftypData, moovBox, ...videoFragments, ...audioFragments];
  const result = concatBuffers(...allParts);

  console.log(`[Muxer] Final file: ${(result.length / 1024 / 1024).toFixed(1)} MB`);
  return result;
}
