import assert from "node:assert/strict";
import test from "node:test";
import { getVisualSeatIndex } from "../lib/poker/engine";
import { MultiplayerRoom } from "../server/multiplayer-room";

test("getVisualSeatIndex: centers hero seat at visual index 0 and preserves relative order", () => {
  const totalSeats = 8;

  // 1. When Hero is at seat 0, visual mapping is identity (0..7)
  for (let seat = 0; seat < totalSeats; seat++) {
    assert.equal(
      getVisualSeatIndex(seat, 0, totalSeats),
      seat,
      `Hero at 0: seat ${seat} should map to visual ${seat}`,
    );
  }

  // 2. For every possible hero seat position (0..7), Hero must be at visual index 0
  for (let heroSeat = 0; heroSeat < totalSeats; heroSeat++) {
    const heroVisual = getVisualSeatIndex(heroSeat, heroSeat, totalSeats);
    assert.equal(
      heroVisual,
      0,
      `Hero at seat ${heroSeat} must be mapped to visual index 0 (middle of the table)`,
    );

    // All visual indices must form a valid permutation of 0..totalSeats-1
    const visualIndices = [];
    for (let seat = 0; seat < totalSeats; seat++) {
      visualIndices.push(getVisualSeatIndex(seat, heroSeat, totalSeats));
    }
    const unique = new Set(visualIndices);
    assert.equal(unique.size, totalSeats, "All visual seat indices must be unique");
    for (let v = 0; v < totalSeats; v++) {
      assert.ok(unique.has(v), `Visual index ${v} must be present`);
    }

    // Relative clockwise ordering must be strictly preserved
    for (let seat = 0; seat < totalSeats; seat++) {
      const nextSeat = (seat + 1) % totalSeats;
      const visualCurrent = getVisualSeatIndex(seat, heroSeat, totalSeats);
      const visualNext = getVisualSeatIndex(nextSeat, heroSeat, totalSeats);
      const distance = (visualNext - visualCurrent + totalSeats) % totalSeats;
      assert.equal(
        distance,
        1,
        `Relative distance between seat ${seat} and ${nextSeat} must be 1 in heroSeat ${heroSeat} view`,
      );
    }
  }

  // 3. When spectator or unseated (heroSeatIndex = -1), keep original seat index
  for (let seat = 0; seat < totalSeats; seat++) {
    assert.equal(
      getVisualSeatIndex(seat, -1, totalSeats),
      seat,
      `Spectator view (-1) should preserve original seat index ${seat}`,
    );
  }
});

test("MultiplayerRoom: each seated player's perspective centers their own seat with relative order preserved", () => {
  const room = new MultiplayerRoom("SEATROT", "host-1", "房主小王", () => {}, {
    minPlayers: 4,
  });

  // Host is seated at seat 0
  // Player 2 and Player 3 join as spectator then take specific seats
  room.join("p2", "玩家老李", true);
  room.takeSeat("p2", 2);
  room.join("p3", "玩家小张", true);
  room.takeSeat("p3", 5);
  // Spectator joins without taking a seat
  room.join("spec-1", "观战小陈", true);

  assert.equal(room.seats[0]?.id, "host-1");
  assert.equal(room.seats[2]?.id, "p2");
  assert.equal(room.seats[5]?.id, "p3");
  assert.equal(room.spectators.has("spec-1"), true);

  // Viewpoint 1: Host ("host-1", seated at 0)
  const hostState = room.buildClientState("host-1");
  const hostSeatIdx = hostState.seats.findIndex((s) => s.id === hostState.myId && !s.id.startsWith("empty-"));
  assert.equal(hostSeatIdx, 0);
  assert.equal(getVisualSeatIndex(0, hostSeatIdx, 8), 0, "Host views self at visual 0");
  assert.equal(getVisualSeatIndex(2, hostSeatIdx, 8), 2, "Host views P2 (seat 2) at visual 2");
  assert.equal(getVisualSeatIndex(5, hostSeatIdx, 8), 5, "Host views P3 (seat 5) at visual 5");

  // Viewpoint 2: Player 2 ("p2", seated at 2)
  const p2State = room.buildClientState("p2");
  const p2SeatIdx = p2State.seats.findIndex((s) => s.id === p2State.myId && !s.id.startsWith("empty-"));
  assert.equal(p2SeatIdx, 2);
  assert.equal(getVisualSeatIndex(2, p2SeatIdx, 8), 0, "P2 views self (seat 2) at visual 0 (centered)");
  assert.equal(getVisualSeatIndex(5, p2SeatIdx, 8), 3, "P2 views P3 (seat 5) at visual 3");
  assert.equal(getVisualSeatIndex(0, p2SeatIdx, 8), 6, "P2 views Host (seat 0) at visual 6");
  // Check relative distances in P2's view:
  // Distance from P2 (visual 0) to P3 (visual 3): 3
  // Distance from P3 (visual 3) to Host (visual 6): 3
  // Distance from Host (visual 6) to P2 (visual 0): 2
  assert.equal((3 - 0 + 8) % 8, (5 - 2 + 8) % 8);
  assert.equal((6 - 3 + 8) % 8, (0 - 5 + 8) % 8);
  assert.equal((0 - 6 + 8) % 8, (2 - 0 + 8) % 8);

  // Viewpoint 3: Player 3 ("p3", seated at 5)
  const p3State = room.buildClientState("p3");
  const p3SeatIdx = p3State.seats.findIndex((s) => s.id === p3State.myId && !s.id.startsWith("empty-"));
  assert.equal(p3SeatIdx, 5);
  assert.equal(getVisualSeatIndex(5, p3SeatIdx, 8), 0, "P3 views self (seat 5) at visual 0 (centered)");
  assert.equal(getVisualSeatIndex(0, p3SeatIdx, 8), 3, "P3 views Host (seat 0) at visual 3");
  assert.equal(getVisualSeatIndex(2, p3SeatIdx, 8), 5, "P3 views P2 (seat 2) at visual 5");
  // Check relative distances in P3's view:
  assert.equal((3 - 0 + 8) % 8, (0 - 5 + 8) % 8);
  assert.equal((5 - 3 + 8) % 8, (2 - 0 + 8) % 8);
  assert.equal((0 - 5 + 8) % 8, (5 - 2 + 8) % 8);

  // Viewpoint 4: Spectator ("spec-1", not seated)
  const specState = room.buildClientState("spec-1");
  const specSeatIdx = !specState.isSpectator
    ? specState.seats.findIndex((s) => s.id === specState.myId && !s.id.startsWith("empty-"))
    : -1;
  assert.equal(specSeatIdx, -1);
  assert.equal(getVisualSeatIndex(0, specSeatIdx, 8), 0, "Spectator views seat 0 at visual 0");
  assert.equal(getVisualSeatIndex(2, specSeatIdx, 8), 2, "Spectator views seat 2 at visual 2");
  assert.equal(getVisualSeatIndex(5, specSeatIdx, 8), 5, "Spectator views seat 5 at visual 5");

  room.cleanup();
});
