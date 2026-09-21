#!/usr/bin/env python3
"""
Full System Automated Integration & Verification Test Suite for Rocky
Verifies:
1. HTTP Health & Status
2. Frontend Serving
3. WebSocket Connection & State Synchronization
4. Speech-to-Text (STT) Transcription
5. Local LLM Generation & Rocky Personality
6. Text-to-Speech (TTS) Audio Generation
7. Complete End-to-End Voice Turn
8. Conversation Store Persistence & Clear
9. Manual Developer Overrides
"""

import sys
import json
import time
import asyncio
import urllib.request
import urllib.parse
import websockets

BASE_URL = "http://127.0.0.1:3000"
WS_URL = "ws://127.0.0.1:3000/ws"

def test_http_get(path, expected_status=200):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as response:
        assert response.status == expected_status, f"Expected {expected_status}, got {response.status}"
        return response.read()

def test_http_post_json(path, data):
    url = f"{BASE_URL}{path}"
    payload = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        assert response.status == 200, f"Expected 200, got {response.status}"
        return json.loads(response.read().decode("utf-8"))

async def test_websocket_lifecycle():
    print("[WS Test] Connecting to WebSocket...", flush=True)
    async with websockets.connect(WS_URL) as ws:
        # Receive initial state
        initial_raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
        initial = json.loads(initial_raw)
        assert initial["event_type"] == "initial_state", f"Expected initial_state, got {initial}"
        print(f"[WS Test] Received initial state: {initial['emotion_state']['state']}", flush=True)

        # Send force emotion
        force_cmd = {
            "type": "force_emotion",
            "payload": {
                "emotion": "happy",
                "intensity": 0.85,
                "gaze": "up"
            }
        }
        await ws.send(json.dumps(force_cmd))

        # Receive state_change
        updated_raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
        updated = json.loads(updated_raw)
        assert updated["event_type"] == "state_change"
        assert updated["emotion_state"]["emotion"] == "happy"
        print("[WS Test] Received confirmed state_change for forced happy emotion!", flush=True)

        # Send speech finished
        await ws.send(json.dumps({"type": "speech_finished"}))
        await asyncio.sleep(0.1)

async def main():
    print("==================================================")
    print("  JIMMY AUTOMATED FULL SYSTEM VERIFICATION SUITE  ")
    print("==================================================")

    # 1. Health
    print("\n1. Testing /health...")
    health_raw = test_http_get("/health")
    health = json.loads(health_raw)
    print(f"Health Response: {health}")
    assert health["backend"] is True
    assert health["llm"] is True
    assert health["stt"] is True
    assert health["tts"] is True
    print("✓ Health check PASSED")

    # 2. Frontend static serving
    print("\n2. Testing frontend static serving...")
    index_html = test_http_get("/").decode("utf-8")
    assert "<canvas id=\"faceCanvas\"" in index_html
    assert "JIMMY" in index_html
    print("✓ Frontend HTML serving PASSED")

    # 3. Status
    print("\n3. Testing /api/status...")
    status_raw = test_http_get("/api/status")
    status = json.loads(status_raw)
    print(f"Status: {status}")
    assert "robot_state" in status
    assert "config" in status
    print("✓ Status check PASSED")

    # 4. WebSocket test
    print("\n4. Testing WebSocket real-time events...")
    await test_websocket_lifecycle()
    print("✓ WebSocket lifecycle PASSED")

    # 5. Chat Interaction (Jimmy LLM & TTS)
    print("\n5. Testing /api/chat interaction...")
    chat_out = test_http_post_json("/api/chat", {
        "message": "That is a bad idea.",
        "synthesize_audio": True
    })
    print(f"Jimmy: '{chat_out['message']}' [Emotion: {chat_out['emotion']}]")
    print(f"Latency: First token {chat_out['latency']['llm_first_token_ms']}ms, Total LLM {chat_out['latency']['llm_total_ms']}ms, TTS {chat_out['latency']['tts_latency_ms']}ms")
    assert len(chat_out["message"]) > 0
    assert chat_out["emotion"] in ["angry", "neutral", "curious", "happy"]
    assert chat_out["audio_base64"] is not None
    assert chat_out["latency"]["llm_first_token_ms"] > 0, "First token latency should be recorded"
    print("✓ Chat and synthesis PASSED")

    # 6. Conversation history
    print("\n6. Testing /api/conversation...")
    conv_raw = test_http_get("/api/conversation")
    conv = json.loads(conv_raw)
    assert len(conv) >= 2, "Conversation should have user and assistant messages"
    print(f"Conversation store has {len(conv)} messages.")
    print("✓ Conversation persistence PASSED")

    # 7. Voice Turn Endpoint
    print("\n7. Testing /api/voice-turn with audio...")
    # Read audio from models/test.wav
    with open("models/test.wav", "rb") as f:
        wav_bytes = f.read()

    boundary = "----WebKitFormBoundaryJimmyVoiceTest123"
    body = (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"audio\"; filename=\"test.wav\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + wav_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        f"{BASE_URL}/api/voice-turn",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        assert resp.status == 200
        voice_res = json.loads(resp.read().decode("utf-8"))

    print(f"Voice Turn Result: Jimmy said '{voice_res['message']}'")
    print(f"Voice Latencies: STT {voice_res['latency']['stt_latency_ms']}ms, LLM 1st token {voice_res['latency']['llm_first_token_ms']}ms, LLM total {voice_res['latency']['llm_total_ms']}ms, TTS {voice_res['latency']['tts_latency_ms']}ms, Pipeline {voice_res['latency']['total_pipeline_ms']}ms")
    assert voice_res["audio_base64"] is not None
    assert voice_res["latency"]["stt_latency_ms"] > 0
    print("✓ End-to-end voice turn PASSED")

    # 8. Clear conversation
    print("\n8. Testing /api/conversation/clear...")
    clear_res = test_http_post_json("/api/conversation/clear", {})
    assert clear_res.get("cleared") is True
    conv_after = json.loads(test_http_get("/api/conversation"))
    assert len(conv_after) == 0
    print("✓ Conversation clear PASSED")

    print("\n==================================================")
    print("  ALL FULL-SYSTEM INTEGRATION TESTS PASSED!       ")
    print("==================================================")

if __name__ == "__main__":
    asyncio.run(main())
