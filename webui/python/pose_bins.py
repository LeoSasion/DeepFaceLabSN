YAW_TICKS = tuple(range(-90, 91, 15))
PITCH_TICKS = tuple(range(60, -61, -15))


def nearest_tick(value, ticks):
    return min(ticks, key=lambda tick: abs(tick - value))


def pose_cell_id(pitch, yaw):
    return f"p{int(pitch)}-y{int(yaw)}"
