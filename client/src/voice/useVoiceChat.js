import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const VOICE_SIGNALING_PATH = '/voice'
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

function getVoiceSignalingUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = window.location.host || 'localhost'
  return `${protocol}://${host}${VOICE_SIGNALING_PATH}`
}

function createPeerId() {
  return `peer-${crypto.randomUUID()}`
}

function upsertParticipant(current, nextParticipant) {
  const next = current.filter((participant) => participant.peerId !== nextParticipant.peerId)
  next.push(nextParticipant)
  return next.sort((left, right) => left.name.localeCompare(right.name))
}

export function useVoiceChat({ roomId, displayName }) {
  const [peerId] = useState(() => createPeerId())
  const [isSupported] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.RTCPeerConnection !== 'undefined' &&
      typeof window.WebSocket !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia
  )
  const [isConnecting, setIsConnecting] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [error, setError] = useState('')
  const [participants, setParticipants] = useState([])
  const socketRef = useRef(null)
  const localStreamRef = useRef(null)
  const peerConnectionsRef = useRef(new Map())
  const pendingCandidatesRef = useRef(new Map())

  const remoteStreams = useMemo(
    () =>
      participants
        .filter((participant) => participant.stream)
        .map((participant) => ({
          peerId: participant.peerId,
          name: participant.name,
          stream: participant.stream,
        })),
    [participants]
  )

  const sendSignal = useCallback((payload) => {
    const socket = socketRef.current

    if (!socket || socket.readyState !== WebSocket.OPEN) return

    socket.send(JSON.stringify(payload))
  }, [])

  const closePeerConnection = useCallback((targetPeerId) => {
    const peerConnection = peerConnectionsRef.current.get(targetPeerId)

    if (peerConnection) {
      peerConnection.onicecandidate = null
      peerConnection.ontrack = null
      peerConnection.onconnectionstatechange = null
      peerConnection.close()
      peerConnectionsRef.current.delete(targetPeerId)
    }

    pendingCandidatesRef.current.delete(targetPeerId)
    setParticipants((current) =>
      current.filter((participant) => participant.peerId !== targetPeerId || !participant.stream)
    )
  }, [])

  const leaveVoice = useCallback(() => {
    sendSignal({
      type: 'leave-voice-room',
      roomId,
      peerId,
    })

    for (const targetPeerId of peerConnectionsRef.current.keys()) {
      closePeerConnection(targetPeerId)
    }

    const socket = socketRef.current
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
      socketRef.current = null
    }

    const localStream = localStreamRef.current
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }

    setParticipants([])
    setIsMuted(false)
    setIsConnected(false)
    setIsConnecting(false)
  }, [closePeerConnection, peerId, roomId, sendSignal])

  const ensurePeerConnection = useCallback(
    (targetPeerId, name = 'Guest') => {
      const existing = peerConnectionsRef.current.get(targetPeerId)

      if (existing) return existing

      const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      const localStream = localStreamRef.current

      if (localStream) {
        for (const track of localStream.getTracks()) {
          peerConnection.addTrack(track, localStream)
        }
      }

      peerConnection.onicecandidate = (event) => {
        if (!event.candidate) return

        sendSignal({
          type: 'voice-ice-candidate',
          roomId,
          peerId,
          targetPeerId,
          candidate: event.candidate,
        })
      }

      peerConnection.ontrack = (event) => {
        const [stream] = event.streams

        if (!stream) return

        setParticipants((current) =>
          upsertParticipant(current, {
            peerId: targetPeerId,
            name,
            stream,
          })
        )
      }

      peerConnection.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(peerConnection.connectionState)) {
          closePeerConnection(targetPeerId)
        }
      }

      peerConnectionsRef.current.set(targetPeerId, peerConnection)
      setParticipants((current) =>
        upsertParticipant(current, {
          peerId: targetPeerId,
          name,
          stream: null,
        })
      )

      const pendingCandidates = pendingCandidatesRef.current.get(targetPeerId) || []
      pendingCandidatesRef.current.delete(targetPeerId)
      pendingCandidates.forEach((candidate) => {
        peerConnection.addIceCandidate(candidate).catch(() => {})
      })

      return peerConnection
    },
    [closePeerConnection, peerId, roomId, sendSignal]
  )

  const joinVoice = useCallback(async () => {
    if (!isSupported || isConnecting || isConnected) return

    setIsConnecting(true)
    setError('')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      localStreamRef.current = stream
      const socket = new WebSocket(getVoiceSignalingUrl())
      socketRef.current = socket

      socket.onopen = () => {
        sendSignal({
          type: 'join-voice-room',
          roomId,
          peerId,
          displayName,
        })
      }

      socket.onmessage = async (event) => {
        const message = JSON.parse(event.data)

        if (message.type === 'voice-joined') {
          setIsConnected(true)
          setIsConnecting(false)
          setParticipants(
            Array.isArray(message.peers)
              ? message.peers.map((peer) => ({
                  peerId: peer.peerId,
                  name: peer.displayName || 'Guest',
                  stream: null,
                }))
              : []
          )

          for (const peer of message.peers || []) {
            const peerConnection = ensurePeerConnection(peer.peerId, peer.displayName || 'Guest')
            const offer = await peerConnection.createOffer()
            await peerConnection.setLocalDescription(offer)

            sendSignal({
              type: 'voice-offer',
              roomId,
              peerId,
              targetPeerId: peer.peerId,
              sdp: offer,
            })
          }

          return
        }

        if (message.type === 'voice-peer-joined') {
          setParticipants((current) =>
            upsertParticipant(current, {
              peerId: message.peerId,
              name: message.displayName || 'Guest',
              stream: null,
            })
          )
          return
        }

        if (message.type === 'voice-peer-left') {
          closePeerConnection(message.peerId)
          setParticipants((current) =>
            current.filter((participant) => participant.peerId !== message.peerId)
          )
          return
        }

        if (message.type === 'voice-offer') {
          const peerConnection = ensurePeerConnection(
            message.peerId,
            message.displayName || 'Guest'
          )
          await peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp))
          const answer = await peerConnection.createAnswer()
          await peerConnection.setLocalDescription(answer)

          sendSignal({
            type: 'voice-answer',
            roomId,
            peerId,
            targetPeerId: message.peerId,
            sdp: answer,
          })
          return
        }

        if (message.type === 'voice-answer') {
          const peerConnection = peerConnectionsRef.current.get(message.peerId)
          if (!peerConnection) return

          await peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp))
          return
        }

        if (message.type === 'voice-ice-candidate') {
          const candidate = new RTCIceCandidate(message.candidate)
          const peerConnection = peerConnectionsRef.current.get(message.peerId)

          if (peerConnection) {
            await peerConnection.addIceCandidate(candidate)
          } else {
            const pending = pendingCandidatesRef.current.get(message.peerId) || []
            pending.push(candidate)
            pendingCandidatesRef.current.set(message.peerId, pending)
          }
        }
      }

      socket.onerror = () => {
        setError('Voice signaling failed.')
      }

      socket.onclose = () => {
        leaveVoice()
      }
    } catch (voiceError) {
      setError(voiceError instanceof Error ? voiceError.message : 'Voice chat failed to start.')
      leaveVoice()
    }
  }, [
    displayName,
    ensurePeerConnection,
    isConnected,
    isConnecting,
    isSupported,
    leaveVoice,
    peerId,
    roomId,
    sendSignal,
  ])

  const toggleMute = useCallback(() => {
    const localStream = localStreamRef.current
    if (!localStream) return

    const nextMuted = !isMuted
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted
    })
    setIsMuted(nextMuted)
  }, [isMuted])

  useEffect(() => leaveVoice, [leaveVoice])

  return {
    isSupported,
    isConnecting,
    isConnected,
    isMuted,
    error,
    participants,
    remoteStreams,
    joinVoice,
    leaveVoice,
    toggleMute,
  }
}
