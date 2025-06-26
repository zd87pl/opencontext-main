import { SatelliteClient } from '../partners/satellite.js';
import { StreamingService } from '../src/streaming.js';
import { Readable } from 'stream';

const SATELLITE_API_KEY = process.env.SATELLITE_API_KEY;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001';
const PASSPORT_ID = process.env.PASSPORT_ID || 'demo-passport-satellite';

if (!SATELLITE_API_KEY) {
  console.error('SATELLITE_API_KEY environment variable required');
  process.exit(1);
}

async function demonstrateImageSearch() {
  console.log('=== Satellite Image Search Demo ===');
  
  const client = new SatelliteClient(SATELLITE_API_KEY);
  
  try {
    const searchRequest = client.createBboxFilter(
      -122.5, 37.7, -122.3, 37.8 // San Francisco Bay Area
    );
    
    console.log('Searching for satellite images in SF Bay Area...');
    const results = await client.searchImages(searchRequest);
    
    console.log(`Found ${results.features.length} images`);
    
    if (results.features.length > 0) {
      const image = results.features[0];
      console.log(`Sample image: ${image.id}`);
      console.log(`  Acquired: ${image.properties.acquired}`);
      console.log(`  Cloud cover: ${image.properties.cloud_cover}%`);
      console.log(`  Resolution: ${image.properties.gsd}m`);
      
      return image;
    }
    
  } catch (error) {
    console.error('Image search error:', error);
  }
  
  return null;
}

async function demonstrateStreamingDownload(imageId: string) {
  console.log('\n=== Large Image Streaming Demo ===');
  
  const client = new SatelliteClient(SATELLITE_API_KEY);
  const streaming = new StreamingService();
  
  try {
    console.log(`Starting streaming download for image: ${imageId}`);
    
    const session = streaming.createSession(
      PASSPORT_ID,
      'satellite',
      50 * 1024 * 1024, // Estimate 50MB image
      '10000000000', // 10 gwei per byte
      1024 * 1024 // 1MB chunks
    );
    
    console.log(`Created streaming session: ${session.id}`);
    console.log(`Estimated cost: ${session.totalCost} wei`);
    
    const imageStream = await client.streamImageDownload(imageId, 'analytic');
    const readableStream = Readable.fromWeb(imageStream);
    
    console.log('Streaming and chunking image data...');
    const chunks = await streaming.streamLargeFile(session.id, readableStream);
    
    console.log(`Image chunked into ${chunks.length} pieces`);
    console.log(`Total size: ${chunks.reduce((sum, chunk) => sum + chunk.size, 0)} bytes`);
    
    let totalCost = 0n;
    chunks.forEach((chunk, i) => {
      const chunkCost = streaming.calculateChunkCost(chunk, session.costPerByte);
      totalCost += BigInt(chunkCost);
      
      if (i < 3) { // Show first 3 chunks
        console.log(`  Chunk ${i}: ${chunk.size} bytes, ${chunkCost} wei, checksum: ${chunk.checksum}`);
      }
    });
    
    console.log(`Total streaming cost: ${totalCost.toString()} wei`);
    
    console.log('\nValidating chunk integrity...');
    const validChunks = chunks.filter(chunk => streaming.validateChunk(chunk));
    console.log(`${validChunks.length}/${chunks.length} chunks validated successfully`);
    
    if (validChunks.length === chunks.length) {
      console.log('✅ All chunks are valid - image can be reconstructed');
      
      console.log('\nReconstructing image from chunks...');
      const reconstructed = streaming.reconstructFromChunks(chunks);
      console.log(`Reconstructed image size: ${reconstructed.length} bytes`);
    }
    
  } catch (error) {
    console.error('Streaming download error:', error);
  }
}

async function testGatewayStreaming() {
  console.log('\n=== Testing Gateway Streaming API ===');
  
  try {
    const response = await fetch(`${GATEWAY_URL}/streaming/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Passport-ID': PASSPORT_ID
      },
      body: JSON.stringify({
        partnerId: 'satellite',
        totalSize: 25 * 1024 * 1024, // 25MB
        costPerByte: '10000000000',
        chunkSize: 512 * 1024 // 512KB chunks
      })
    });

    if (!response.ok) {
      throw new Error(`Gateway error: ${response.status}`);
    }

    const session = await response.json();
    console.log(`Gateway streaming session created: ${session.id}`);
    console.log(`Estimated cost: ${session.totalCost} wei`);
    
    const statusResponse = await fetch(`${GATEWAY_URL}/streaming/sessions/${session.id}`);
    if (statusResponse.ok) {
      const status = await statusResponse.json();
      console.log(`Session status: ${status.status}`);
      console.log(`Chunks processed: ${status.chunks.length}`);
    }
    
  } catch (error) {
    console.error('Gateway streaming test error:', error);
  }
}

async function main() {
  const sampleImage = await demonstrateImageSearch();
  
  if (sampleImage) {
    await demonstrateStreamingDownload(sampleImage.id);
  } else {
    console.log('Skipping streaming demo - no sample image found');
  }
  
  await testGatewayStreaming();
}

main().catch(console.error);