"""Run SparkyFitness's Garmin service on IPv4 and IPv6 at once.

The stock main.py listens on 0.0.0.0 only. Fly.io's private network (how the SparkyFitness server
reaches this service) is IPv6, while its health checks use IPv4, and asyncio makes a "::" listener
IPv6-only, so one socket per family is needed. Where IPv6 isn't available (plain Docker) it falls
back to IPv4 only, exactly like the stock image.
"""
import os
import socket

import uvicorn

from main import app

PORT = int(os.getenv("GARMIN_SERVICE_PORT", "8000"))


def listener(family: int, address: str) -> socket.socket:
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if family == socket.AF_INET6:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    sock.bind((address, PORT))
    return sock


sockets = []
for family, address in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
    try:
        sockets.append(listener(family, address))
        print(f"garmin service listening on {address}:{PORT}", flush=True)
    except OSError as err:
        print(f"garmin service: not listening on {address} ({err})", flush=True)

if not sockets:
    raise SystemExit("garmin service could not bind any address")

uvicorn.Server(uvicorn.Config(app, log_level="info")).run(sockets=sockets)
