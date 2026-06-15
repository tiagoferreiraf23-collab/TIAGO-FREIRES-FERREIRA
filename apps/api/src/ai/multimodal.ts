/**
 * Multimodal helpers:
 *  - Location: Google Maps reverse geocoding
 *  - Audio: OpenAI Whisper transcription
 *  - Image / PDF go directly to Claude (no helper needed)
 */
import axios from 'axios'
import OpenAI, { toFile } from 'openai'
import { env } from '../config'
import { createChildLogger } from '../logger'

const log = createChildLogger('multimodal')

const openai = env.openai.apiKey ? new OpenAI({ apiKey: env.openai.apiKey }) : null

/** Best-effort mime-type → file extension mapping (Whisper accepts mp3/mp4/mpeg/mpga/m4a/wav/webm/ogg). */
function audioExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase()
  if (lower.includes('ogg') || lower.includes('opus')) return 'ogg'
  if (lower.includes('webm')) return 'webm'
  if (lower.includes('m4a')) return 'm4a'
  if (lower.includes('mp4') || lower.includes('aac')) return 'mp4'
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3'
  if (lower.includes('wav') || lower.includes('wave')) return 'wav'
  return 'ogg'  // WhatsApp default
}

/** Transcribe a buffer of audio bytes to text (pt-BR) using OpenAI Whisper. */
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string | null> {
  if (!openai) {
    log.warn('OPENAI_API_KEY not set — audio transcription disabled')
    return null
  }
  if (buffer.length > 25 * 1024 * 1024) {
    log.warn({ sizeMb: (buffer.length / 1024 / 1024).toFixed(1) }, 'Audio exceeds Whisper 25 MB limit')
    return null
  }
  try {
    const filename = `audio.${audioExtension(mimeType)}`
    const file = await toFile(buffer, filename, { type: mimeType })
    const response = await openai.audio.transcriptions.create({
      file,
      model: env.openai.whisperModel,
      language: 'pt',
      response_format: 'json',
    })
    const text = (response as { text?: string }).text?.trim() ?? null
    log.info(
      { bytes: buffer.length, mimeType, transcriptLength: text?.length ?? 0 },
      'Audio transcribed',
    )
    return text
  } catch (err) {
    log.error({ err, mimeType }, 'Whisper transcription failed')
    return null
  }
}

/** Reverse-geocode latitude/longitude to a human-readable Brazilian address. */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<{ formattedAddress: string; city?: string; state?: string } | null> {
  if (!env.google.mapsApiKey) {
    log.warn('GOOGLE_MAPS_API_KEY not set — returning raw lat/lng as fallback')
    return { formattedAddress: `${latitude},${longitude} (sem chave Maps configurada)` }
  }

  try {
    const response = await axios.get<{
      status: string
      results: Array<{
        formatted_address: string
        address_components: Array<{ long_name: string; types: string[] }>
      }>
    }>('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        latlng: `${latitude},${longitude}`,
        key: env.google.mapsApiKey,
        language: 'pt-BR',
        result_type: 'street_address|premise|subpremise|route',
      },
      timeout: 10000,
    })

    if (response.data.status !== 'OK' || !response.data.results.length) {
      log.warn({ status: response.data.status, latitude, longitude }, 'Google Maps returned no result')
      return null
    }

    // The first result is usually the most precise
    const top = response.data.results[0]
    const components = top.address_components

    const findComp = (type: string) =>
      components.find((c) => c.types.includes(type))?.long_name

    return {
      formattedAddress: top.formatted_address,
      city: findComp('administrative_area_level_2') ?? findComp('locality'),
      state: findComp('administrative_area_level_1'),
    }
  } catch (err) {
    log.error({ err, latitude, longitude }, 'Reverse geocoding failed')
    return null
  }
}
