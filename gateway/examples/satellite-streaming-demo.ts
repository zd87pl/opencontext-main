/**
 * Satellite imagery demo: search Planet for a scene, stream the download through the chunking
 * transform with per-byte metering, verify checksums and reconstruct the file.
 *
 *   SATELLITE_API_KEY=... npx tsx examples/satellite-streaming-demo.ts
 */

import { Readable } from 'node:stream';
import { SatelliteClient } from '../partners/satellite.js';
import { StreamingService } from '../src/streaming.js';
import type { StreamingSession } from '../src/types.js';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3001';
const PASSPORT_ID = process.env.PASSPORT_ID ?? 'demo-passport-satellite';
const ITEM_TYPE = 'PSScene';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} environment variable required`);
    process.exit(1);
  }
  return value;
}

const SATELLITE_API_KEY = requireEnv('SATELLITE_API_KEY');

async function findSampleImage(client: SatelliteClient): Promise<string | null> {
  console.log('=== Satellite image search (San Francisco Bay Area) ===');
  const results = await client.searchImages(client.createBboxFilter(-122.5, 37.7, -122.3, 37.8));
  console.log(`Found ${results.features.length} scenes`);
  const image = results.features[0];
  if (!image) return null;
  console.log(`Sample: ${image.id} acquired ${image.properties.acquired}, cloud cover ${image.properties.cloud_cover}`);
  return image.id;
}

async function streamDownload(client: SatelliteClient, imageId: string): Promise<void> {
  console.log('\n=== Chunked, metered download ===');
  const streaming = new StreamingService();
  const session = await streaming.createSession(
    PASSPORT_ID,
    'satellite',
    50 * 1024 * 1024, // declared size: 50 MB estimate
    '10000000000', // 10 gwei per byte
    1024 * 1024 // 1 MB chunks
  );
  console.log(`Session ${session.id}: quoted cost ${session.totalCost} wei`);

  const webStream = await client.streamImageDownload(ITEM_TYPE, imageId);
  const chunks = await streaming.streamLargeFile(session.id, Readable.fromWeb(webStream));

  const bytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  console.log(`Received ${chunks.length} chunks, ${bytes} bytes`);
  chunks.slice(0, 3).forEach((chunk) => {
    console.log(
      `  chunk ${chunk.sequence}: ${chunk.size} bytes, ${streaming.calculateChunkCost(chunk, session.costPerByte)} wei, ${chunk.checksum.slice(0, 18)}...`
    );
  });

  const valid = chunks.filter((chunk) => streaming.validateChunk(chunk)).length;
  console.log(`${valid}/${chunks.length} chunks verified`);
  const reconstructed = streaming.reconstructFromChunks(chunks);
  console.log(`Reconstructed ${reconstructed.length} bytes`);

  const finalSession = await streaming.getSession(session.id);
  console.log(`Session status: ${finalSession?.status}, accrued cost: ${finalSession?.accruedCost} wei`);
  await streaming.close();
}

async function testGatewayStreamingApi(): Promise<void> {
  console.log('\n=== Gateway streaming API ===');
  const response = await fetch(`${GATEWAY_URL}/streaming/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Passport-ID': PASSPORT_ID },
    body: JSON.stringify({
      passportId: PASSPORT_ID,
      partnerId: 'satellite',
      totalSize: 25 * 1024 * 1024,
      costPerByte: '10000000000',
      chunkSize: 512 * 1024,
    }),
  });
  if (!response.ok) {
    throw new Error(`Gateway error: ${response.status} ${await response.text()}`);
  }
  const session = (await response.json()) as StreamingSession;
  console.log(`Gateway session ${session.id}: quoted cost ${session.totalCost} wei`);

  const status = await fetch(`${GATEWAY_URL}/streaming/sessions/${session.id}`);
  const current = (await status.json()) as StreamingSession;
  console.log(`Status: ${current.status}, chunks processed: ${current.chunks.length}`);
}

async function main(): Promise<void> {
  const client = new SatelliteClient(SATELLITE_API_KEY);
  const imageId = await findSampleImage(client);
  if (imageId) {
    await streamDownload(client, imageId);
  } else {
    console.log('No scene found, skipping the download demo');
  }
  await testGatewayStreamingApi();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
