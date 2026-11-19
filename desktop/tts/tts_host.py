#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tts_host.py — hôte vocal de repli (sans PyQt6)
===============================================================================
⚠️  Ce fichier est un HÔTE DE DÉVELOPPEMENT.

La voix de production du dépôt est l'hôte PyQt6/QTextToSpeech décrit dans
`desktop/README.md` (§ Voix) : voix Windows SAPI/OneCore, événements
`sayingWord` de Qt convertis en repères de mots, port 127.0.0.1:8649.

Celui-ci n'émet AUCUN son : il répond au même protocole JSON par ligne et
diffuse des repères `start` / `boundary` / `end` au rythme du texte. Il sert à
vérifier que la coque Electron fonctionne (lipsync, réglages, mémoire) sur une
machine sans Python/PyQt6, sans jamais bloquer l'application.

Il ne prend la main que si aucun hôte n'écoute déjà sur le port.

PROTOCOLE (une ligne JSON par message, dans les deux sens)
---------------------------------------------------------------------------
  <- {"type":"hello","client":"sarra-electron"}
  <- {"type":"voices"}
  -> {"type":"ready"}
  -> {"type":"voices","voices":[{"name":"Hortense","lang":"fr-FR","default":true}]}
  <- {"type":"speak","id":12,"text":"Bonjour","voice":"Hortense","lang":"fr-FR","rate":1}
  -> {"type":"start","id":12}
  -> {"type":"boundary","id":12,"charIndex":0,"charLength":7,"word":"Bonjour","elapsedTime":0}
  -> {"type":"end","id":12}
  <- {"type":"stop"}

USAGE
  python desktop/tts/tts_host.py --port 8649 --log desktop/tts-host.log
===============================================================================
"""

import argparse
import json
import socketserver
import sys
import threading
import time

LANGS = "fr-FR"


def log_line(message, log_path=None):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}"
    print(line, flush=True)
    if log_path:
        try:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass


class Utterance(threading.Thread):
    """Simule la lecture : découpe le texte en mots et émet les repères."""

    def __init__(self, handler, utterance_id, text, rate):
        super().__init__(daemon=True)
        self.handler = handler
        self.utterance_id = utterance_id
        self.text = text
        self.rate = rate or 1.0
        self.cancelled = False

    def send(self, payload):
        payload.setdefault("id", self.utterance_id)
        self.handler.push(payload)

    def run(self):
        self.send({"type": "start"})
        started = time.monotonic()
        cursor = 0
        words = self.text.split(" ")

        for word in words:
            if self.cancelled or self.handler.closed:
                return
            index = self.text.find(word, cursor)
            if index < 0:
                index = cursor
            cursor = index + len(word)
            self.send({
                "type": "boundary",
                "charIndex": index,
                "charLength": len(word),
                "word": word,
                "elapsedTime": int((time.monotonic() - started) * 1000),
            })
            # ~5,5 caractères/seconde : proche du débit labial du profilcalibré
            duration = max(0.14, (len(word) / (5.5 * float(self.rate))))
            deadline = time.monotonic() + duration
            while time.monotonic() < deadline:
                if self.cancelled or self.handler.closed:
                    return
                time.sleep(0.02)
            cursor += 1

        self.send({"type": "end"})


class Handler(socketserver.StreamRequestHandler):
    def setup(self):
        super().setup()
        self.closed = False
        self.lock = threading.Lock()
        self.current = None
        self.send({"type": "ready"})
        self.send({
            "type": "voices",
            "voices": [
                {"name": "Hortense (repli, silencieux)", "lang": LANGS, "default": True},
                {"name": "Julie (repli, silencieux)", "lang": LANGS, "default": False},
            ],
        })

    # -- émission ---------------------------------------------------------
    def send(self, payload):
        self.push(payload)

    def push(self, payload):
        if self.closed:
            return
        with self.lock:
            try:
                self.wfile.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, OSError):
                self.closed = True

    # -- réception --------------------------------------------------------
    def handle(self):
        for raw in self.rfile:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                log_line(f"JSON invalide : {line[:120]}")
                continue
            self.dispatch(message)

    def dispatch(self, message):
        kind = message.get("type")

        if kind in ("hello",):
            self.send({"type": "ready"})
            return

        if kind == "voices":
            self.send({
                "type": "voices",
                "voices": [
                    {"name": "Hortense (repli, silencieux)", "lang": LANGS, "default": True},
                    {"name": "Julie (repli, silencieux)", "lang": LANGS, "default": False},
                ],
            })
            return

        if kind == "speak":
            text = str(message.get("text") or "").strip()
            if not text:
                return
            if self.current is not None:
                self.current.cancelled = True
            self.current = Utterance(self, message.get("id"), text, message.get("rate"))
            self.current.start()
            return

        if kind == "stop":
            if self.current is not None:
                self.current.cancelled = True
                self.send({"type": "end"})
            return

        log_line(f"message inconnu : {kind}")

    def finish(self):
        self.closed = True
        try:
            super().finish()
        except OSError:
            pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description="Hôte vocal de repli (sans son) pour Sarra.")
    parser.add_argument("--port", type=int, default=8649)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--log", default=None)
    args = parser.parse_args()

    try:
        server = Server((args.host, args.port), Handler)
    except OSError as exc:
        log_line(f"port {args.port} indisponible : {exc}", args.log)
        return 1

    log_line(f"hôte vocal de repli à l'écoute sur {args.host}:{args.port} (aucun son émis)", args.log)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
