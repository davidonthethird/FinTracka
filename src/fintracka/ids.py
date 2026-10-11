from __future__ import annotations

import secrets
import threading
import time
import uuid

_lock = threading.Lock()
_last_millisecond = -1
_last_random = 0


def new_id() -> str:
    """Return a monotonic UUIDv7 string, including on Python versions before 3.14."""
    global _last_millisecond, _last_random
    with _lock:
        millisecond = int(time.time_ns() // 1_000_000)
        if millisecond == _last_millisecond:
            random_bits = (_last_random + 1) & ((1 << 74) - 1)
            if random_bits == 0:
                millisecond += 1
        else:
            random_bits = secrets.randbits(74)
        _last_millisecond = millisecond
        _last_random = random_bits

    rand_a = random_bits >> 62
    rand_b = random_bits & ((1 << 62) - 1)
    value = (
        (millisecond << 80)
        | (0x7 << 76)
        | (rand_a << 64)
        | (0b10 << 62)
        | rand_b
    )
    return str(uuid.UUID(int=value))

