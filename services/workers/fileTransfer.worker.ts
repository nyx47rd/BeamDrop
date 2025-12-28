
/// <reference lib="webworker" />

self.onmessage = async (e: MessageEvent) => {
  const { type, file, chunkSize, startOffset, context } = e.data;

  if (type === 'init') {
    // Worker initialized
  } 
  else if (type === 'read_chunk') {
    try {
      if (!file) throw new Error("File not provided");

      const end = Math.min(startOffset + chunkSize, file.size);
      const blobSlice = file.slice(startOffset, end);
      const arrayBuffer = await blobSlice.arrayBuffer();

      // Send the buffer back to main thread
      // We use Transferable Objects (the second argument array) to move memory 
      // instead of copying it. This is extremely fast (Zero-Copy).
      self.postMessage(
        { 
          type: 'chunk_ready', 
          buffer: arrayBuffer, 
          offset: end, 
          eof: end >= file.size,
          context: context // Pass back context (e.g. chunk index) if provided
        }, 
        [arrayBuffer]
      );
    } catch (error) {
      self.postMessage({ type: 'error', error });
    }
  }
};
