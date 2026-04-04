import { useCallback, useEffect, useRef, useState } from 'react'

function getPreferredMimeType() {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return ''

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ''
}

export function useVoice({ onFinalTranscript } = {}) {
  const [transcript, setTranscript] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [error, setError] = useState('')
  const [isSupported] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof MediaRecorder !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia
  )
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const chunksRef = useRef([])
  const onFinalTranscriptRef = useRef(onFinalTranscript)

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript
  }, [onFinalTranscript])

  const resetRecorderResources = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      mediaRecorderRef.current = null
    }

    const stream = mediaStreamRef.current
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    chunksRef.current = []
  }, [])

  useEffect(() => resetRecorderResources, [resetRecorderResources])

  const transcribeBlob = useCallback(
    async (blob) => {
      setIsTranscribing(true)
      setError('')

      try {
        const response = await fetch('/api/transcribe', {
          method: 'POST',
          headers: {
            'Content-Type': blob.type || 'application/octet-stream',
            'X-Audio-Mime-Type': blob.type || 'application/octet-stream',
            'X-Audio-Filename': blob.type.includes('mp4') ? 'voice-note.m4a' : 'voice-note.webm',
          },
          body: blob,
        })

        const payload = await response.json()

        if (!response.ok) {
          throw new Error(payload.error || 'Transcription failed.')
        }

        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        setTranscript(text)

        if (text) {
          await onFinalTranscriptRef.current?.(text)
        }
      } catch (voiceError) {
        setError(voiceError instanceof Error ? voiceError.message : 'Transcription failed.')
      } finally {
        setIsTranscribing(false)
      }
    },
    []
  )

  return {
    transcript,
    isListening,
    isTranscribing,
    isSupported,
    error,
    async startListening() {
      if (!isSupported || isListening || isTranscribing) return

      setError('')
      setTranscript('')

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        const mimeType = getPreferredMimeType()
        const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)

        mediaStreamRef.current = stream
        mediaRecorderRef.current = mediaRecorder
        chunksRef.current = []

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunksRef.current.push(event.data)
          }
        }

        mediaRecorder.onerror = () => {
          setError('Recording failed.')
          setIsListening(false)
          resetRecorderResources()
        }

        mediaRecorder.onstop = async () => {
          setIsListening(false)

          const mime = mediaRecorder.mimeType || mimeType || 'audio/webm'
          const blob = new Blob(chunksRef.current, { type: mime })
          resetRecorderResources()

          if (blob.size > 0) {
            await transcribeBlob(blob)
          }
        }

        mediaRecorder.start()
        setIsListening(true)
      } catch (voiceError) {
        setError(voiceError instanceof Error ? voiceError.message : 'Microphone access failed.')
        resetRecorderResources()
      }
    },
    stopListening() {
      const mediaRecorder = mediaRecorderRef.current

      if (!mediaRecorder || mediaRecorder.state === 'inactive') return

      mediaRecorder.stop()
    },
  }
}
