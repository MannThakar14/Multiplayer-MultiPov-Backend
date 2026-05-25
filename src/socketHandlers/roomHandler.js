const crypto = require("crypto");
const { SocketEvents } = require("../constants/socketEvents");

const rooms = {};
let activeUnrealServer = null;
const multiPovUnrealInstances = {};
const disconnectedUsers = {};
const reconnectCloseTimers = {};

const RECONNECT_WINDOW_MS = 1 * 60 * 1000; // 1 minute

const getReconnectKey = (room_id, user_id) => {
  if (!room_id || !user_id) return null;
  return `${room_id}:${user_id}`;
};

module.exports = (io, socket) => {
  const getRoom = (room_id) => rooms[room_id];

  const getSocketEventName = (key, fallback) => {
    return SocketEvents[key] || fallback;
  };

  const getCloseConnectionEventName = () => {
    return SocketEvents.CLOSE_CONNECTION || "close_connection";
  };

  const emitEvent = (target, event_name, data = {}) => {
    const logPayload = {
      event_name,
      data,
    };

    console.log("📤 Emit Event:", JSON.stringify(logPayload, null, 2));

    target.emit(SocketEvents.BACKEND_EVENT, logPayload);
  };

  const getSocketIp = (socketInstance) => {
    const forwarded = socketInstance.handshake?.headers?.["x-forwarded-for"];

    if (forwarded) {
      return forwarded.split(",")[0].trim();
    }

    return socketInstance.handshake?.address || null;
  };

  const normalizeIp = (ip) => {
    if (!ip) return null;

    let value = String(ip).trim();

    if (value === "::1") return "127.0.0.1";

    if (value.startsWith("::ffff:")) {
      value = value.replace("::ffff:", "");
    }

    return value;
  };

  const getNormalizedSocketIp = (socketInstance) => {
    return normalizeIp(getSocketIp(socketInstance));
  };

  const normalizeSessionType = (sessionType) => {
    if (sessionType === "multi_pov") return "multipov";
    if (sessionType === "multipov") return "multipov";
    return "multiplayer";
  };

  const isMultiPovRoom = (room) => {
    return normalizeSessionType(room?.session_type) === "multipov";
  };

  const getMultiPovKey = (ip) => {
    return normalizeIp(ip);
  };

  const findMultiPovUnrealByIp = (ip) => {
    const key = getMultiPovKey(ip);
    if (!key) return null;

    const data = multiPovUnrealInstances[key];
    if (!data) return null;

    const multipovSocket = io.sockets.sockets.get(data.socket_id);

    if (!multipovSocket) {
      delete multiPovUnrealInstances[key];
      return null;
    }

    return multipovSocket;
  };

  const getRoomMultiPovSocket = (room) => {
    if (!room || !isMultiPovRoom(room)) return null;

    const socketById = room.host_multipov_socket_id
      ? io.sockets.sockets.get(room.host_multipov_socket_id)
      : null;

    if (socketById) return socketById;

    return findMultiPovUnrealByIp(room.host_multipov_ip || room.host_ip);
  };

  const emitCreatePlayerToMultiPovUnreal = (
    room,
    userSocketId,
    isMidSessionJoin = false,
  ) => {
    const multipovSocket = getRoomMultiPovSocket(room);

    if (!multipovSocket) {
      console.log(
        "No host Multi POV Unreal instance found for create_player:",
        {
          room_id: room?.room_id,
          host_ip: room?.host_ip,
          host_multipov_socket_id: room?.host_multipov_socket_id,
          target_user_socket_id: userSocketId,
        },
      );

      return false;
    }

    const role = userSocketId === room.host_id ? "prime" : "spectator";

    emitEvent(multipovSocket, SocketEvents.CREATE_PLAYER || "create_player", {
      room_id: room.room_id,
      streamer_id: userSocketId,
      role,
      session_type: "multipov",
      mid_session_join: isMidSessionJoin,
      username: room.usernames[userSocketId],
    });

    //  emitEvent(multipovSocket, SocketEvents?.PLAYER_INFO, {
    //       username: room.usernames[userSocketId],
    //       role,
    //     });

    return true;
  };

  const emitDeletePlayerToMultiPovUnreal = (room, userSocketId) => {
    const multipovSocket = getRoomMultiPovSocket(room);

    if (!multipovSocket) {
      console.log(
        "No host Multi POV Unreal instance found for delete_player:",
        {
          room_id: room?.room_id,
          host_ip: room?.host_ip,
          host_multipov_socket_id: room?.host_multipov_socket_id,
          target_user_socket_id: userSocketId,
        },
      );

      return false;
    }

    emitEvent(multipovSocket, SocketEvents.DELETE_PLAYER || "delete_player", {
      streamer_id: userSocketId,
    });

    return true;
  };

  const emitCloseUnrealToMultiPovRoom = (room) => {
    const multipovSocket = getRoomMultiPovSocket(room);

    if (!multipovSocket) {
      console.log("No host Multi POV Unreal instance found for close_unreal:", {
        room_id: room?.room_id,
        host_ip: room?.host_ip,
        host_multipov_socket_id: room?.host_multipov_socket_id,
      });

      return false;
    }

    emitEvent(multipovSocket, SocketEvents.CLOSE_UNREAL || "close_unreal");

    return true;
  };

  const emitToMultiPovRoomUnreal = (room, eventName, data = {}) => {
    const multipovSocket = getRoomMultiPovSocket(room);

    if (!multipovSocket) {
      console.log("No host Multi POV Unreal instance found:", {
        room_id: room?.room_id,
        eventName,
        host_ip: room?.host_ip,
        host_multipov_socket_id: room?.host_multipov_socket_id,
      });

      return false;
    }

    emitEvent(multipovSocket, eventName, data);

    return true;
  };

  const isDedicatedServerSocket = (socketInstance) => {
    return (
      socketInstance?.is_unreal_server_socket === true ||
      socketInstance?.is_unreal_dedicated_server === true
    );
  };

  const isPairedUnrealSocket = (socketInstance) => {
    return (
      (socketInstance?.is_unreal_socket === true ||
        socketInstance?.is_unreal_client === true) &&
      socketInstance?.is_unreal_multipov_instance !== true &&
      !isDedicatedServerSocket(socketInstance)
    );
  };

  const isFrontendSocket = (socketInstance) => {
    return (
      !!socketInstance &&
      socketInstance?.is_unreal_multipov_instance !== true &&
      !isPairedUnrealSocket(socketInstance) &&
      !isDedicatedServerSocket(socketInstance)
    );
  };

  const getPairedUnrealIp = (socketInstance) => {
    return normalizeIp(
      socketInstance?.unreal_ip ||
        socketInstance?.client_ip ||
        getSocketIp(socketInstance),
    );
  };

  const applyActiveDedicatedServerToRoom = (room) => {
    if (!room || !activeUnrealServer?.socket_id) return;

    room.dedicated_server_socket_id = activeUnrealServer.socket_id;
    room.dedicated_server_ip = activeUnrealServer.ip || null;
    room.dedicated_server_port = activeUnrealServer.port || null;
  };

  const clearActiveDedicatedServerIfSocketMatches = (socketId) => {
    if (activeUnrealServer?.socket_id !== socketId) return;

    activeUnrealServer = null;

    Object.values(rooms).forEach((room) => {
      if (room.dedicated_server_socket_id === socketId) {
        room.dedicated_server_socket_id = null;
        room.dedicated_server_ip = null;
        room.dedicated_server_port = null;
      }
    });
  };

  const findUnrealClientOrSocketByIp = (ip, excludeSocketId = null) => {
    if (!ip) return null;

    const normalizedTargetIp = normalizeIp(ip);

    for (const s of io.sockets.sockets.values()) {
      const unrealIp = getPairedUnrealIp(s);

      if (
        s.id !== excludeSocketId &&
        isPairedUnrealSocket(s) &&
        unrealIp === normalizedTargetIp
      ) {
        return s;
      }
    }

    return null;
  };

  const findUnrealClientByUserId = (userId, excludeSocketId = null) => {
    if (!userId) return null;

    for (const s of io.sockets.sockets.values()) {
      if (
        s.id !== excludeSocketId &&
        isPairedUnrealSocket(s) &&
        String(s.unreal_user_id) === String(userId)
      ) {
        return s;
      }
    }

    return null;
  };

  const findFrontendSocketByIp = (ip, excludeSocketId = null) => {
    if (!ip) return null;

    const normalizedTargetIp = normalizeIp(ip);

    for (const s of io.sockets.sockets.values()) {
      const frontendIp = getNormalizedSocketIp(s);

      if (
        s.id !== excludeSocketId &&
        isFrontendSocket(s) &&
        frontendIp === normalizedTargetIp
      ) {
        return s;
      }
    }

    return null;
  };

  const emitCloseConnectionToSocket = (targetSocket, data = {}) => {
    if (!targetSocket) return false;

    emitEvent(targetSocket, getCloseConnectionEventName(), {
      close_connection: true,
      ...data,
    });

    return true;
  };

  const notifyPairedUnrealForFeDisconnect = (
    room,
    disconnectedSocketId,
    isManualLeave = false,
    socketInstance = null,
  ) => {
    if (isMultiPovRoom(room)) {
      return false;
    }

    const userId =
      room.user_ids?.[disconnectedSocketId] || socketInstance?.user_id || null;

    const feIp = normalizeIp(
      room.user_ips?.[disconnectedSocketId] ||
        socketInstance?.client_ip ||
        socketInstance?.unreal_ip ||
        getSocketIp(socketInstance),
    );

    if (!feIp) {
      console.log("Cannot find Unreal by IP because FE IP is missing:", {
        fe_socket_id: disconnectedSocketId,
        user_id: userId,
      });

      return false;
    }

    const unrealSocket = findUnrealClientOrSocketByIp(
      feIp,
      disconnectedSocketId,
    );

    if (!unrealSocket) {
      console.log("No matching Unreal found for FE disconnect by IP:", {
        fe_socket_id: disconnectedSocketId,
        user_id: userId,
        fe_ip: feIp,
      });

      return false;
    }

    return emitCloseConnectionToSocket(unrealSocket, {
      room_id: room.room_id,
      source: "fe",
      target: "unreal",
      reason: isManualLeave ? "fe_left_room" : "fe_disconnected",
      fe_socket_id: disconnectedSocketId,
      unreal_socket_id: unrealSocket.id,
      user_id: userId,
      username:
        room.usernames?.[disconnectedSocketId] ||
        socketInstance?.username ||
        "Unknown",
      ip: feIp,
      message: isManualLeave
        ? "Matching FE left the room. Close this Unreal connection."
        : "Matching FE disconnected. Close this Unreal connection.",
    });
  };

  const notifyPairedFeForUnrealDisconnect = (disconnectedUnrealSocket) => {
    if (!isPairedUnrealSocket(disconnectedUnrealSocket)) return false;

    const unrealUserId = disconnectedUnrealSocket.unreal_user_id || null;
    const unrealIp = getPairedUnrealIp(disconnectedUnrealSocket);

    console.log("Unreal client disconnected:", {
      unreal_socket_id: disconnectedUnrealSocket.id,
      unreal_user_id: unrealUserId,
      unreal_ip: unrealIp,
    });

    return false;
  };

  const getUserList = (room) => {
    return room.users.map((sid) => {
      const disconnectedInfo = room.disconnected_sockets?.[sid] || null;

      return {
        socket_id: sid,
        user_id: room.user_ids[sid] || null,
        username: room.usernames[sid] || "Unknown",
        role: room.roles[sid] || "spectator",
        approved: room.approved_sockets.includes(sid),
        ip: room.user_ips[sid] || null,
        connected: !disconnectedInfo,
        disconnected: !!disconnectedInfo,
        disconnected_at: disconnectedInfo?.disconnected_at || null,
      };
    });
  };

  const emitConnectInfoToUser = (userSocket, room) => {
    if (
      !userSocket ||
      !room?.host_connection?.ip ||
      !room?.host_connection?.port
    ) {
      return;
    }

    emitEvent(userSocket, SocketEvents.CONNECT_TO_SESSION, {
      room_id: room.room_id,
      host: {
        socket_id: room.host_id,
        user_id: room.host_user_id,
        username: room.usernames[room.host_id] || "Host",
        ip: room.host_connection.ip,
        port: room.host_connection.port,
      },
    });
  };

  const emitJoinServerToRoomUnrealSockets = (room) => {
    console.log(">>>>>>>>>>>>>>>>>>>>>>>>>>JOIN SERVER>>>>>>>room called ", {
      server_ip: room.dedicated_server_ip,
      server_port: room.dedicated_server_port,
    });

    const JOIN_SERVER_EVENT = SocketEvents.JOIN_SERVER || "join_server";
    // const PLAYER_INFO = SocketEvents.PLAYER_INFO || "player_info";

    const emittedUnrealSocketIds = new Set();

    for (const userSocketId of room.approved_sockets) {
      const userIp = room.user_ips[userSocketId];

      const unrealSocket = findUnrealClientOrSocketByIp(userIp, userSocketId);

      if (!unrealSocket) {
        console.log("No matching Unreal client/socket found for user:", {
          userSocketId,
          userIp,
        });

        continue;
      }

      if (emittedUnrealSocketIds.has(unrealSocket.id)) continue;

      emittedUnrealSocketIds.add(unrealSocket.id);

      const role = userSocketId === room.host_id ? "prime" : "spectator";

      emitEvent(unrealSocket, JOIN_SERVER_EVENT, {
        room_id: room.room_id,
        server_ip: room.dedicated_server_ip,
        server_port: room.dedicated_server_port,
        streamer_id: userSocketId,
        role,
        username: room.usernames[userSocketId],
      });
      // emitEvent(unrealSocket, SocketEvents.PLAYER_INFO, {
      //   username: room.usernames[userSocketId],
      //   role,
      // });
    }
  };

  const emitDisconnectUnrealClientToRoom = (room) => {
    if (isMultiPovRoom(room)) {
      emitCloseUnrealToMultiPovRoom(room);
      return;
    }

    const DISCONNECT_UNREAL_CLIENT_EVENT =
      SocketEvents.DISCONNECT_UNREAL_CLIENT || "disconnect_unreal_client";

    const emittedUnrealSocketIds = new Set();

    emitEvent(io.to(room.room_id), DISCONNECT_UNREAL_CLIENT_EVENT);

    for (const userSocketId of room.approved_sockets) {
      const userIp = room.user_ips[userSocketId];

      const unrealSocket = findUnrealClientOrSocketByIp(userIp, userSocketId);

      if (!unrealSocket) {
        console.log("No matching Unreal socket found for stop session:", {
          room_id: room.room_id,
          fe_socket_id: userSocketId,
          ip: userIp,
        });

        continue;
      }

      if (emittedUnrealSocketIds.has(unrealSocket.id)) continue;

      emittedUnrealSocketIds.add(unrealSocket.id);

      emitEvent(unrealSocket, DISCONNECT_UNREAL_CLIENT_EVENT);
    }
  };

  const emitResetDedicatedServer = (room) => {
    const RESET_DEDICATED_SERVER_EVENT =
      SocketEvents.RESET_DEDICATED_SERVER || "reset_dedicated_server";

    applyActiveDedicatedServerToRoom(room);

    if (!room.dedicated_server_socket_id) {
      console.log("No dedicated server socket found for reset:", {
        room_id: room.room_id,
      });

      return false;
    }

    emitEvent(
      io.to(room.dedicated_server_socket_id),
      RESET_DEDICATED_SERVER_EVENT,
    );

    return true;
  };

  const emitJoinServerToUserUnrealSocket = (room, userSocketId) => {
    if (isMultiPovRoom(room)) {
      return emitCreatePlayerToMultiPovUnreal(room, userSocketId, true);
    }

    const JOIN_SERVER_EVENT = SocketEvents.JOIN_SERVER || "join_server";

    const userIp = room.user_ips[userSocketId];

    const unrealSocket = findUnrealClientOrSocketByIp(userIp, userSocketId);

    if (!unrealSocket) {
      console.log(
        "No matching Unreal client/socket found for mid-session user:",
        {
          userSocketId,
          userIp,
        },
      );

      return null;
    }

    const role = userSocketId === room.host_id ? "prime" : "spectator";

    emitEvent(unrealSocket, JOIN_SERVER_EVENT, {
      room_id: room.room_id,
      server_ip: room.dedicated_server_ip,
      server_port: room.dedicated_server_port,
      streamer_id: userSocketId,
      role,
      mid_session_join: room.session_started === true,
      message: room.session_started
        ? "Join running session server"
        : "Join session server",
      username: room.usernames[userSocketId],
    });

    return unrealSocket;
  };

  const findRoomBySocketId = (socketId) => {
    return Object.values(rooms).find(
      (room) =>
        room.users.includes(socketId) ||
        room.pending_requests.includes(socketId),
    );
  };

  const findRoomByUserId = (userId) => {
    if (!userId) return null;

    return Object.values(rooms).find((room) =>
      Object.values(room.user_ids).includes(userId),
    );
  };

  const getRoomByHostUserId = (userId) => {
    if (!userId) return null;

    return Object.values(rooms).find(
      (room) => room.host_user_id && room.host_user_id === userId,
    );
  };

  const findRoomByIp = (ip) => {
    if (!ip) return null;

    return Object.values(rooms).find((room) =>
      Object.values(room.user_ips || {}).includes(ip),
    );
  };

  const cleanupSocketFromRoom = (room, socketId) => {
    room.users = room.users.filter((id) => id !== socketId);
    room.pending_requests = room.pending_requests.filter(
      (id) => id !== socketId,
    );
    room.approved_sockets = room.approved_sockets.filter(
      (id) => id !== socketId,
    );

    delete room.usernames[socketId];
    delete room.user_ids[socketId];
    delete room.user_ips[socketId];
    delete room.roles[socketId];
  };

  // const closeRoom = (room_id, room, reasonPayload = {}) => {
  //   emitEvent(io.to(room_id), SocketEvents.ROOM_CLOSED, {
  //     room_id,
  //     message: "Room closed.",
  //     ...reasonPayload,
  //   });

  //   const allSockets = new Set([...room.users, ...room.pending_requests]);

  //   for (const sid of allSockets) {
  //     const s = io.sockets.sockets.get(sid);
  //     if (s) {
  //       s.leave(room_id);
  //     }
  //   }

  //   delete rooms[room_id];
  // };

  const closeRoom = (room_id, room, reasonPayload = {}) => {
    emitRoomClosedToAllRoomSockets(room_id, room, {
      message: "Room closed.",
      ...reasonPayload,
    });

    const allSockets = new Set([
      ...(room.users || []),
      ...(room.approved_sockets || []),
      ...(room.pending_requests || []),
    ]);

    for (const sid of allSockets) {
      const s = io.sockets.sockets.get(sid);

      if (s) {
        s.leave(room_id);

        if (s.room_id === room_id) {
          s.room_id = null;
        }

        s.role = null;
      }
    }

    Object.keys(disconnectedUsers).forEach((key) => {
      if (disconnectedUsers[key]?.room_id === room_id) {
        delete disconnectedUsers[key];
      }
    });

    Object.keys(reconnectCloseTimers).forEach((key) => {
      if (key.startsWith(`${room_id}:`)) {
        clearTimeout(reconnectCloseTimers[key]);
        delete reconnectCloseTimers[key];
      }
    });

    delete rooms[room_id];
  };
  const emitRoomClosedToAllRoomSockets = (room_id, room, payload = {}) => {
    const notifiedSocketIds = new Set();

    const allRoomSocketIds = new Set([
      ...(room.users || []),
      ...(room.approved_sockets || []),
      ...(room.pending_requests || []),
    ]);

    for (const sid of allRoomSocketIds) {
      if (!sid || notifiedSocketIds.has(sid)) continue;

      const targetSocket = io.sockets.sockets.get(sid);

      if (!targetSocket) continue;

      notifiedSocketIds.add(sid);

      emitEvent(targetSocket, SocketEvents.ROOM_CLOSED, {
        room_id,
        ...payload,
      });
    }

    /**
     * Optional fallback:
     * This covers any sockets that already joined the Socket.IO room.
     * Pending users normally won't receive this because they are not joined yet.
     */
    emitEvent(io.to(room_id), SocketEvents.ROOM_CLOSED, {
      room_id,
      ...payload,
    });
  };

  const destroyMultiPovRoomBecauseHostLeft = (
    room_id,
    room,
    hostSocketId,
    reason = "host_left",
    extraPayload = {},
  ) => {
    /**
     * Multi POV has only one host-owned Unreal POV instance.
     * If host leaves, destroy whole room.
     */

    emitDeletePlayersForAllMultiPovUsers(room);
    emitCloseUnrealToMultiPovRoom(room);

    /**
     * Important:
     * Notify users + approved users + pending requests directly.
     * Pending users are not joined to Socket.IO room_id yet.
     */
    emitRoomClosedToAllRoomSockets(room_id, room, {
      socket_id: hostSocketId,
      user_id: room.user_ids?.[hostSocketId] || room.host_user_id || null,
      username: room.usernames?.[hostSocketId] || "Host",
      reason,
      message:
        reason === "host_disconnected"
          ? "Host disconnected. Multi POV room closed."
          : "Host left the room. Multi POV room closed.",
      ...extraPayload,
    });

    const allRoomSocketIds = new Set([
      ...(room.users || []),
      ...(room.approved_sockets || []),
      ...(room.pending_requests || []),
    ]);

    for (const sid of allRoomSocketIds) {
      const roomSocket = io.sockets.sockets.get(sid);

      if (roomSocket) {
        roomSocket.leave(room_id);

        if (roomSocket.room_id === room_id) {
          roomSocket.room_id = null;
        }

        roomSocket.role = null;
      }
    }

    Object.keys(disconnectedUsers).forEach((key) => {
      if (disconnectedUsers[key]?.room_id === room_id) {
        delete disconnectedUsers[key];
      }
    });

    Object.keys(reconnectCloseTimers).forEach((key) => {
      if (key.startsWith(`${room_id}:`)) {
        clearTimeout(reconnectCloseTimers[key]);
        delete reconnectCloseTimers[key];
      }
    });

    delete rooms[room_id];

    console.log("Multi POV room destroyed because host left/disconnected:", {
      room_id,
      host_socket_id: hostSocketId,
      reason,
    });
  };

  const scheduleUnrealCloseAfterReconnectWindow = (
    room_id,
    room,
    disconnectedSocketId,
    socketInstance = null,
  ) => {
    const userId =
      room.user_ids?.[disconnectedSocketId] || socketInstance?.user_id || null;

    if (!userId) return;

    const reconnectKey = getReconnectKey(room_id, userId);
    if (!reconnectKey) return;

    if (reconnectCloseTimers[reconnectKey]) {
      clearTimeout(reconnectCloseTimers[reconnectKey]);
      delete reconnectCloseTimers[reconnectKey];
    }

    reconnectCloseTimers[reconnectKey] = setTimeout(() => {
      const reconnectData = disconnectedUsers[reconnectKey];

      if (!reconnectData) {
        delete reconnectCloseTimers[reconnectKey];
        return;
      }

      const latestRoom = getRoom(room_id);

      if (!latestRoom) {
        delete disconnectedUsers[reconnectKey];
        delete reconnectCloseTimers[reconnectKey];
        return;
      }

      if (isMultiPovRoom(latestRoom)) {
        emitDeletePlayerToMultiPovUnreal(
          latestRoom,
          reconnectData.old_socket_id,
        );
      } else {
        const unrealIp = normalizeIp(reconnectData.ip);

        // const unrealSocket = findUnrealClientOrSocketByIp(
        //   unrealIp,
        //   reconnectData.old_socket_id,
        // );
        const unrealSocket = reconnectData.unreal_socket_id
          ? io.sockets.sockets.get(reconnectData.unreal_socket_id)
          : null;

        if (unrealSocket) {
          emitCloseConnectionToSocket(unrealSocket, {
            room_id,
            source: "backend",
            target: "unreal",
            reason: "reconnect_timeout",
            user_id: reconnectData.user_id,
            username: reconnectData.username,
            role: reconnectData.role,
            ip: unrealIp,
            old_fe_socket_id: reconnectData.old_socket_id,
            unreal_socket_id: unrealSocket.id,
            reconnect_window_ms: RECONNECT_WINDOW_MS,
            message: "Reconnect window expired. Close this Unreal connection.",
          });
        }
      }

      delete disconnectedUsers[reconnectKey];
      delete reconnectCloseTimers[reconnectKey];
    }, RECONNECT_WINDOW_MS);
  };

  const chooseRandomNewHostSocketId = (room, exclude = {}) => {
    const { oldSocketId = null, oldUserId = null, oldIp = null } = exclude;

    const normalizedOldIp = normalizeIp(oldIp);

    if (!normalizedOldIp) return null;

    const candidates = room.approved_sockets.filter((sid) => {
      if (!room.users.includes(sid)) return false;
      if (!io.sockets.sockets.has(sid)) return false;

      const candidateUserId = room.user_ids[sid] || null;
      const candidateIp = normalizeIp(room.user_ips[sid] || null);

      if (oldSocketId && sid === oldSocketId) return false;

      if (
        oldUserId &&
        candidateUserId &&
        String(candidateUserId) === String(oldUserId)
      ) {
        return false;
      }

      if (!candidateIp || candidateIp === normalizedOldIp) return false;

      return true;
    });

    if (candidates.length === 0) return null;

    return candidates[0];
  };

  const promoteRandomHostAfterHostLeft = (
    room_id,
    room,
    disconnectedSocketId,
    isManualLeave = false,
    oldHostSnapshot = null,
  ) => {
    if (isMultiPovRoom(room)) {
      emitCloseUnrealToMultiPovRoom(room);

      return closeRoom(room_id, room, {
        socket_id: disconnectedSocketId,
        message: "Multi POV host left. Room closed.",
      });
    }

    const oldHost = oldHostSnapshot || {
      socket_id: disconnectedSocketId,
      user_id:
        room.user_ids?.[disconnectedSocketId] || room.host_user_id || null,
      username:
        room.usernames?.[disconnectedSocketId] ||
        room.usernames?.[room.host_id] ||
        "Host",
      ip: normalizeIp(
        room.user_ips?.[disconnectedSocketId] || room.host_ip || null,
      ),
    };

    oldHost.ip = normalizeIp(oldHost.ip);

    if (room.host_id !== disconnectedSocketId) {
      return null;
    }

    if (!oldHost.ip) {
      return closeRoom(room_id, room, {
        socket_id: disconnectedSocketId,
        user_id: oldHost.user_id,
        username: oldHost.username,
        ip: oldHost.ip,
        message: "Host left but old host IP is missing. Room closed.",
      });
    }

    cleanupSocketFromRoom(room, disconnectedSocketId);

    const candidates = room.approved_sockets.filter((sid) => {
      if (!room.users.includes(sid)) return false;
      if (!io.sockets.sockets.has(sid)) return false;

      const candidateUserId = room.user_ids?.[sid] || null;
      const candidateIp = normalizeIp(room.user_ips?.[sid] || null);

      if (sid === disconnectedSocketId) return false;

      if (
        oldHost.user_id &&
        candidateUserId &&
        String(candidateUserId) === String(oldHost.user_id)
      ) {
        return false;
      }

      if (!candidateIp || candidateIp === oldHost.ip) return false;

      return true;
    });

    // if (candidates.length === 0) {
    //   return closeRoom(room_id, room, {
    //     socket_id: disconnectedSocketId,
    //     user_id: oldHost.user_id,
    //     username: oldHost.username,
    //     ip: oldHost.ip,
    //     message:
    //       "Host left and no approved user from a different IP is available. Room closed.",
    //   });
    // }
    if (candidates.length === 0) {
      /**
       * No other approved player is available.
       * Do NOT close the room immediately.
       * Keep old host as host and wait for reconnect.
       */
      room.host_id = disconnectedSocketId;
      room.host_user_id = oldHost.user_id || room.host_user_id || null;
      room.host_ip = oldHost.ip || room.host_ip || null;
      room.host_reconnect_pending = true;
      room.host_disconnected_at = Date.now();

      room.disconnected_sockets = room.disconnected_sockets || {};
      room.disconnected_sockets[disconnectedSocketId] = {
        user_id: oldHost.user_id,
        username: oldHost.username,
        role: "prime",
        disconnected_at: Date.now(),
      };

      emitEvent(
        io.to(room_id),
        SocketEvents.HOST_DISCONNECTED || "host_disconnected",
        {
          room_id,
          old_host: oldHost,
          reconnect_window_ms: RECONNECT_WINDOW_MS,
          message: "Host disconnected. Waiting for host to reconnect.",
        },
      );

      console.log(
        "Host disconnected but no replacement available. Waiting for reconnect:",
        {
          room_id,
          old_host_socket_id: disconnectedSocketId,
          old_host_user_id: oldHost.user_id,
          old_host_ip: oldHost.ip,
        },
      );

      return null;
    }

    const newHostSocketId = candidates[0];
    const newHostIp = normalizeIp(room.user_ips?.[newHostSocketId] || null);

    if (!newHostIp || newHostIp === oldHost.ip) {
      return closeRoom(room_id, room, {
        socket_id: disconnectedSocketId,
        user_id: oldHost.user_id,
        username: oldHost.username,
        ip: oldHost.ip,
        message:
          "Host left and selected replacement was invalid or from same IP. Room closed.",
      });
    }

    const newHostUnrealSocket = findUnrealClientOrSocketByIp(
      newHostIp,
      newHostSocketId,
    );

    room.host_id = newHostSocketId;
    room.host_user_id = room.user_ids?.[newHostSocketId] || null;
    room.host_ip = newHostIp;
    room.host_unreal_socket_id = newHostUnrealSocket
      ? newHostUnrealSocket.id
      : null;
    room.host_unreal_ip = newHostUnrealSocket
      ? normalizeIp(
          newHostUnrealSocket.unreal_ip ||
            newHostUnrealSocket.client_ip ||
            getSocketIp(newHostUnrealSocket),
        )
      : null;

    for (const sid of room.approved_sockets) {
      room.roles[sid] = sid === newHostSocketId ? "prime" : "spectator";
    }

    const newHostSocket = io.sockets.sockets.get(newHostSocketId);

    if (newHostSocket) {
      newHostSocket.role = "prime";
      newHostSocket.user_id = room.host_user_id;
      newHostSocket.username = room.usernames?.[newHostSocketId] || "Host";
    }

    const newHost = {
      socket_id: newHostSocketId,
      user_id: room.host_user_id,
      username: room.usernames?.[newHostSocketId] || "Host",
      ip: room.host_ip,
      role: "prime",
    };

    const current_users = getUserList(room);

    emitEvent(
      io.to(room_id),
      getSocketEventName("HOST_CHANGED", "host_changed"),
      {
        room_id,
        old_host: oldHost,
        new_host: newHost,
        users: current_users,
        session_started: room.session_started,
        session_starting: room.session_starting,
        message: isManualLeave
          ? "Host left the room. A new host was selected."
          : "Host disconnected. A new host was selected.",
        game_mode: room.game_mode,
      },
    );

    if (newHostSocket) {
      emitEvent(
        newHostSocket,
        getSocketEventName("YOU_ARE_NEW_HOST", "you_are_new_host"),
        {
          room_id,
          role: "prime",
          host: newHost,
          users: current_users,
          can_start_session: !room.session_started && !room.session_starting,
          can_stop_session: room.session_started,
          message: "You are now the room host.",
        },
      );
    }

    if (newHostUnrealSocket) {
      emitEvent(newHostUnrealSocket, SocketEvents.UNREAL_ROLE_CHANGED, {
        room_id,
        role: "prime",
        host: newHost,
        users: current_users,
        server_ip: room.dedicated_server_ip,
        server_port: room.dedicated_server_port,
        fe_socket_id: newHostSocketId,
        unreal_socket_id: newHostUnrealSocket.id,
        message: "You are now the room host.",
      });
    }

    return newHostSocketId;
  };

  socket.on(
    SocketEvents.CREATE_ROOM,

    ({ username, user_id, session_type = "multiplayer" } = {}) => {
      session_type = normalizeSessionType(session_type);
      console.log(
        ">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>create room>>>>>>>>>>>>>>>>>>>>>>>>",
      );

      const allowedSessionTypes = ["multiplayer", "multipov"];

      if (!allowedSessionTypes.includes(session_type)) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Invalid session_type",
          allowed_session_types: allowedSessionTypes,
        });
      }

      socket.user_id = user_id || null;
      socket.username = username || "Host";
      socket.role = "prime";
      socket.is_frontend = true;

      const ip = getNormalizedSocketIp(socket);

      const existingRoomBySocket = findRoomBySocketId(socket.id);
      const existingRoomByUser = user_id ? findRoomByUserId(user_id) : null;
      const existingRoomByIp = findRoomByIp(ip);

      const allSockets = Array.from(io.sockets.sockets.values());

      const unrealSocket = allSockets.find((s) => {
        return (
          s.id !== socket.id &&
          s.is_unreal_socket === true &&
          normalizeIp(s.unreal_ip || getSocketIp(s)) === ip
        );
      });

      const multipovSocket =
        session_type === "multipov" ? findMultiPovUnrealByIp(ip) : null;

      const room_id = crypto.randomUUID().slice(0, 8);

      rooms[room_id] = {
        room_id,
        session_type,

        host_id: socket.id,
        host_user_id: user_id || null,
        host_ip: ip,

        host_unreal_socket_id: unrealSocket ? unrealSocket.id : null,
        host_unreal_ip: unrealSocket ? unrealSocket.unreal_ip : null,

        host_multipov_socket_id: multipovSocket ? multipovSocket.id : null,
        host_multipov_ip: multipovSocket
          ? multipovSocket.multipov_ip || ip
          : null,

        dedicated_server_socket_id: activeUnrealServer?.socket_id || null,
        dedicated_server_ip: activeUnrealServer?.ip || null,
        dedicated_server_port: activeUnrealServer?.port || null,

        host_connection: {
          ip: null,
          port: null,
        },

        users: [socket.id],
        approved_sockets: [socket.id],
        pending_requests: [],

        session_started: false,
        session_starting: false,
        session_start_request_id: null,

        game_mode: null,
        game_mode_changing: false,
        game_mode_request_id: null,
        pending_game_mode: null,

        spawned_cubes: 0,
        max_cubes: null,
        cube_spawn_in_progress: false,
        cube_spawn_request_id: null,
        cube_spawn_requested_by: null,

        usernames: {
          [socket.id]: username || "Host",
        },

        user_ids: {
          [socket.id]: user_id || null,
        },

        user_ips: {
          [socket.id]: ip,
        },

        roles: {
          [socket.id]: "prime",
        },
      };

      socket.join(room_id);

      emitEvent(socket, SocketEvents.ROOM_CREATED, {
        room_id,
        session_type,
        host_id: socket.id,
        user_id: user_id || null,
        username: username || "Host",
        role: "prime",
        approved: true,
        host_connection: rooms[room_id].host_connection,
        session_started: false,
        session_starting: false,
        host_unreal_socket_id: rooms[room_id].host_unreal_socket_id,
        host_multipov_socket_id: rooms[room_id].host_multipov_socket_id,
        dedicated_server_ip: rooms[room_id].dedicated_server_ip,
        dedicated_server_port: rooms[room_id].dedicated_server_port,
      });

      const room = rooms[room_id];

      if (isMultiPovRoom(room)) {
        const didEmitCreatePlayer = emitCreatePlayerToMultiPovUnreal(
          room,
          socket.id,
          false,
        );

        if (!didEmitCreatePlayer) {
          emitEvent(socket, SocketEvents.ERROR, {
            room_id,
            message: "No matching Multi POV Unreal instance found for host IP",
            ip,
          });
        }

        return;
      }

      if (unrealSocket) {
        emitEvent(unrealSocket, SocketEvents.USER_JOINED_ROOM, {
          room_id,
          host_id: socket.id,
          host_unreal_socket_id: unrealSocket.id,
          server_ip: room.dedicated_server_ip,
          server_port: room.dedicated_server_port,
          message: "Room created successfully for paired Unreal instance",
        });
      } else {
        console.log("No matching Unreal socket found for host IP:", ip);
      }
    },
  );

  socket.on(
    SocketEvents.UPDATE_HOST_CONNECTION,
    ({ room_id, host_ip, host_port } = {}) => {
      const room = getRoom(room_id);

      if (!room) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Room not found",
        });
      }

      if (room.host_id !== socket.id) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Unauthorized: Only host can update connection info",
        });
      }

      room.host_connection = {
        ip: host_ip || room.host_connection.ip,
        port: host_port || room.host_connection.port,
      };

      emitEvent(socket, SocketEvents.HOST_CONNECTION_UPDATED, {
        room_id,
        host_connection: room.host_connection,
      });
    },
  );

  socket.on(
    SocketEvents.JOIN_ROOM_REQUEST,
    ({ room_id, username, user_id, session_type } = {}) => {
      socket.user_id = user_id || null;
      socket.username = username || "Guest";
      socket.role = "spectator";
      socket.is_frontend = true;
      session_type = normalizeSessionType(session_type);

      const room = getRoom(room_id);

      // if(room?.session_type != session_type ){

      //   return emitEvent(socket, SocketEvents.JOIN_REQUEST_FAILED, {
      //     room_id,
      //     message: `Room created for ${room?.session_type} and you are trying to join with ${session_type}`,
      //   });
      // }

      if (!room) {
        return emitEvent(socket, SocketEvents.JOIN_REQUEST_FAILED, {
          room_id,
          message: "Room not found",
        });
      }

      const ip = getNormalizedSocketIp(socket);

      const existingRoomBySocket = findRoomBySocketId(socket.id);

      if (existingRoomBySocket && existingRoomBySocket.room_id !== room_id) {
        return emitEvent(socket, SocketEvents.JOIN_REQUEST_FAILED, {
          room_id,
          message: "You are already active in another room",
        });
      }

      if (room.users.includes(socket.id)) {
        return emitEvent(socket, SocketEvents.JOIN_REQUEST_FAILED, {
          room_id,
          message: "You are already in this room",
        });
      }

      room.usernames[socket.id] = username || "Guest";
      room.user_ids[socket.id] = user_id || null;
      room.user_ips[socket.id] = ip;
      room.roles[socket.id] = "spectator";

      room.pending_requests.push(socket.id);

      const hostSocket = io.sockets.sockets.get(room.host_id);

      if (!hostSocket) {
        cleanupSocketFromRoom(room, socket.id);

        return emitEvent(socket, SocketEvents.JOIN_REQUEST_FAILED, {
          room_id,
          message: "Host is not available",
        });
      }

      emitEvent(hostSocket, SocketEvents.JOIN_REQUEST, {
        room_id,
        socket_id: socket.id,
        user_id: user_id || null,
        username: username || "Guest",
        ip,
        message: "User wants to join the room",
      });

      emitEvent(socket, SocketEvents.JOIN_REQUEST_SENT, {
        room_id,
        message: "Join request sent to host. Waiting for approval.",
      });
    },
  );

  socket.on(SocketEvents.APPROVE_USER, ({ room_id, target_socket_id } = {}) => {
    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (room.host_id !== socket.id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Unauthorized: Only host can approve users",
      });
    }

    if (!target_socket_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "target_socket_id is required",
      });
    }

    const userSocket = io.sockets.sockets.get(target_socket_id);

    if (!userSocket) {
      cleanupSocketFromRoom(room, target_socket_id);

      return emitEvent(socket, SocketEvents.ERROR, {
        message: "User socket not found or disconnected",
      });
    }

    room.pending_requests = room.pending_requests.filter(
      (id) => id !== target_socket_id,
    );

    if (!room.users.includes(target_socket_id)) {
      room.users.push(target_socket_id);
    }

    if (!room.approved_sockets.includes(target_socket_id)) {
      room.approved_sockets.push(target_socket_id);
    }

    room.roles[target_socket_id] = "spectator";

    userSocket.join(room_id);

    const current_users = getUserList(room);

    emitEvent(userSocket, SocketEvents.JOIN_APPROVED, {
      room_id,
      host: {
        socket_id: room.host_id,
        user_id: room.host_user_id,
        username: room.usernames[room.host_id] || "Host",
      },
      users: current_users,
      role: room.roles[target_socket_id],
      approved: true,
      session_started: room.session_started,
      session_starting: room.session_starting,
      message: room.session_started
        ? "Approved and session already started"
        : "Approved. Waiting for host session to start",
    });

    emitEvent(io.to(room_id), SocketEvents.USER_JOINED, {
      room_id,
      socket_id: target_socket_id,
      user_id: room.user_ids[target_socket_id] || null,
      username: room.usernames[target_socket_id] || "Guest",
      role: room.roles[target_socket_id],
      approved: true,
      user_count: room.users.length,
    });

    const approvedUserIp = normalizeIp(room.user_ips[target_socket_id]);

    const approvedUserUnrealSocket = findUnrealClientOrSocketByIp(
      approvedUserIp,
      target_socket_id,
    );

    if (isMultiPovRoom(room)) {
      const didEmitCreatePlayer = emitCreatePlayerToMultiPovUnreal(
        room,
        target_socket_id,
        room.session_started === true,
      );

      if (!didEmitCreatePlayer) {
        return emitEvent(userSocket, SocketEvents.ERROR, {
          room_id,
          message: "No host Multi POV Unreal instance found for approved user",
          host_ip: room.host_ip,
          host_multipov_socket_id: room.host_multipov_socket_id,
          approved_user_ip: approvedUserIp,
          approved_user_unreal_socket_id: approvedUserUnrealSocket
            ? approvedUserUnrealSocket.id
            : null,
          target_socket_id,
        });
      }
    } else {
      if (approvedUserUnrealSocket) {
        emitEvent(approvedUserUnrealSocket, SocketEvents.USER_JOINED_ROOM, {
          room_id,
          host_id: room.host_id,
          host_unreal_socket_id: room.host_unreal_socket_id,
          server_ip: room.dedicated_server_ip,
          server_port: room.dedicated_server_port,
          message: room.session_started
            ? "User approved and paired with Unreal instance during running session"
            : "User approved and paired with Unreal instance",
        });
      } else {
        console.log("No matching unreal socket found for approved user IP:", {
          approvedUserIp,
          target_socket_id,
        });
      }
    }

    if (room.session_started) {
      applyActiveDedicatedServerToRoom(room);

      if (!isMultiPovRoom(room)) {
        if (approvedUserUnrealSocket) {
          const JOIN_SERVER_EVENT = SocketEvents.JOIN_SERVER || "join_server";

          emitEvent(approvedUserUnrealSocket, JOIN_SERVER_EVENT, {
            room_id,
            server_ip: room.dedicated_server_ip,
            server_port: room.dedicated_server_port,
            streamer_id: target_socket_id,
            role: "spectator",
            mid_session_join: true,
            message: "Join running session server",
            username: room.usernames[target_socket_id],
          });
          //     emitEvent(unrealSocket,SocketEvents.PLAYER_INFO, {
          //   username: room.usernames[approvedUserUnrealSocket],
          //   role,
          // });
        } else {
          return emitEvent(userSocket, SocketEvents.ERROR, {
            room_id,
            message: "No matching Unreal socket found for this user",
          });
        }
      }

      emitEvent(userSocket, SocketEvents.SESSION_STARTED, {
        room_id,
        session_type: room.session_type,
        server_ip: room.dedicated_server_ip,
        server_port: room.dedicated_server_port,
        streamer_id: target_socket_id,
        host: {
          socket_id: room.host_id,
          user_id: room.host_user_id,
          username: room.usernames[room.host_id] || "Host",
          ip: room.host_connection?.ip || room.dedicated_server_ip || null,
          port:
            room.host_connection?.port || room.dedicated_server_port || null,
        },
        spawned_cubes: room.spawned_cubes,
        game_mode: room.game_mode,
        user_id: room.user_ids[target_socket_id] || null,
        role: "spectator",
        approved: true,
        mid_session_join: true,
        message: isMultiPovRoom(room)
          ? "Approved and player created in Multi POV session"
          : "Approved and joined an already running session",
      });

      emitConnectInfoToUser(userSocket, room);
    }
  });

  socket.on(SocketEvents.CANCEL_JOIN_REQUEST, ({ room_id } = {}) => {
    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        room_id,
        message: "Room not found",
      });
    }

    if (!room.pending_requests.includes(socket.id)) {
      return emitEvent(socket, SocketEvents.ERROR, {
        room_id,
        message: "No pending join request found",
      });
    }

    const cancelledUser = {
      socket_id: socket.id,
      user_id: room.user_ids[socket.id] || null,
      username: room.usernames[socket.id] || "Guest",
      ip: room.user_ips[socket.id] || null,
    };

    cleanupSocketFromRoom(room, socket.id);

    const hostSocket = io.sockets.sockets.get(room.host_id);

    if (hostSocket) {
      emitEvent(hostSocket, SocketEvents.JOIN_REQUEST_CANCELLED, {
        room_id,
        ...cancelledUser,
        message: "Guest cancelled join request",
      });
    }

    emitEvent(socket, SocketEvents.JOIN_REQUEST_CANCELLED, {
      room_id,
      ...cancelledUser,
      message: "Join request cancelled",
    });
  });

  socket.on(SocketEvents.REJECT_USER, ({ room_id, target_socket_id } = {}) => {
    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (room.host_id !== socket.id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Unauthorized: Only host can reject users",
      });
    }

    if (!target_socket_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "target_socket_id is required",
      });
    }

    room.pending_requests = room.pending_requests.filter(
      (id) => id !== target_socket_id,
    );

    const userSocket = io.sockets.sockets.get(target_socket_id);

    if (userSocket) {
      emitEvent(userSocket, SocketEvents.JOIN_REJECTED, {
        room_id,
        reason: "Request rejected by host",
      });
    }

    cleanupSocketFromRoom(room, target_socket_id);
  });

  socket.on(SocketEvents.START_SESSION, ({ room_id } = {}) => {
    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (room.host_id !== socket.id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Unauthorized: Only current host can start session",
      });
    }

    if (room.session_started) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Session already started",
      });
    }

    if (room.session_starting) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Session is already starting",
      });
    }

    applyActiveDedicatedServerToRoom(room);
    if (room.session_type != "multipov") {
      if (!room.dedicated_server_socket_id) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Dedicated server is not registered",
        });
      }
      if (!room.dedicated_server_ip || !room.dedicated_server_port) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Dedicated server IP and port are missing",
        });
      }
    }

    room.session_starting = true;
    room.session_start_request_id = crypto.randomUUID();

    if (!isMultiPovRoom(room)) {
      emitJoinServerToRoomUnrealSockets(room);
    }

    for (const userSocketId of room.approved_sockets) {
      const userSocket = io.sockets.sockets.get(userSocketId);
      if (!userSocket) continue;

      const isHost = userSocketId === room.host_id;

      emitEvent(userSocket, SocketEvents.SESSION_STARTED, {
        room_id,
        session_type: room.session_type,
        server_ip: room.dedicated_server_ip,
        server_port: room.dedicated_server_port,
        role: isHost ? "prime" : "spectator",
        spawned_cubes: room.spawned_cubes,
      });
    }

    room.session_started = true;
    // room.session_starting = false;
  });

  socket.on(SocketEvents.START_SESSION_REQUESTED_REVERT, ({ data } = {}) => {
    const {
      room_id,
      request_id,
      status,
      host_ip,
      host_port,
      error_code,
      error_message,
    } = data || {};

    if (!room_id || !request_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "room_id and request_id are required",
      });
    }

    if (status !== "success" && status !== "failure") {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: 'status must be either "success" or "failure"',
      });
    }

    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (!room.session_starting) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "No session start is currently in progress",
      });
    }

    if (room.session_start_request_id !== request_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Invalid or expired session request_id",
      });
    }

    if (status === "success") {
      room.session_started = true;
      room.session_starting = false;
      room.session_start_request_id = null;

      room.host_connection = {
        ip: host_ip || room.dedicated_server_ip || null,
        port: host_port || room.dedicated_server_port || null,
      };

      if (room.dedicated_server_socket_id) {
        emitEvent(
          io.to(room.dedicated_server_socket_id),
          SocketEvents.SESSION_STARTED,
          {
            room_id,
            server_ip: room.dedicated_server_ip,
            server_port: room.dedicated_server_port,
            role: "prime",
            spawned_cubes: room.spawned_cubes,
          },
        );
      }

      for (const userSocketId of room.approved_sockets) {
        const userSocket = io.sockets.sockets.get(userSocketId);
        if (!userSocket) continue;

        const isHost = userSocketId === room.host_id;

        emitEvent(userSocket, SocketEvents.SESSION_STARTED, {
          room_id,
          session_type: room.session_type,
          server_ip: isHost
            ? room.dedicated_server_ip
            : room.host_connection.ip,
          server_port: isHost
            ? room.dedicated_server_port
            : room.host_connection.port,
          role: isHost ? "prime" : "spectator",
          spawned_cubes: room.spawned_cubes,
        });

        if (!isHost) {
          emitConnectInfoToUser(userSocket, room);
        }
      }

      return;
    }

    room.session_started = false;
    room.session_starting = false;
    room.session_start_request_id = null;
    room.host_connection = {
      ip: null,
      port: null,
    };

    emitEvent(io.to(room_id), SocketEvents.SESSION_START_FAILED, {
      room_id,
      error_code: error_code || null,
      message: error_message || "Failed to create session",
    });
  });

  socket.on(SocketEvents.STOP_SESSION, ({ room_id } = {}) => {
    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (room.host_id !== socket.id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Unauthorized: Only current host can stop session",
      });
    }

    if (isMultiPovRoom(room)) {
      /**
       * Multi POV:
       * First delete every player from host POV Unreal instance.
       * Then close Unreal.
       */
      emitDeletePlayersForAllMultiPovUsers(room);

      emitCloseUnrealToMultiPovRoom(room);
    } else {
      /**
       * Multiplayer:
       * Existing flow remains same.
       */
      emitDisconnectUnrealClientToRoom(room);
      emitResetDedicatedServer(room);
    }
    // emitEvent(io.to(room_id), SocketEvents.SESSION_STOPPED, {
    //   room_id,
    //   message: "Session stopped by host",
    // });

    const allRoomSocketId = new Set([
      ...(room.users || []),
      ...(room.approved_sockets || []),
      ...(room.pending_requests || []),
    ]);

    for (const sid of allRoomSocketId) {
      const targetSocket = io.sockets.sockets.get(sid);

      if (!targetSocket) continue;

      emitEvent(targetSocket, SocketEvents.SESSION_STOPPED, {
        room_id,
        message: "Session stopped by host",
      });
    }

    const allRoomSocketIds = new Set([
      ...(room.users || []),
      ...(room.approved_sockets || []),
      ...(room.pending_requests || []),
    ]);

    for (const sid of allRoomSocketIds) {
      const roomSocket = io.sockets.sockets.get(sid);

      if (roomSocket) {
        roomSocket.leave(room_id);

        if (roomSocket.room_id === room_id) {
          roomSocket.room_id = null;
        }

        roomSocket.role = null;
      }
    }

    Object.keys(disconnectedUsers).forEach((key) => {
      if (disconnectedUsers[key]?.room_id === room_id) {
        delete disconnectedUsers[key];
      }
    });

    delete rooms[room_id];

    console.log("Session stopped and room deleted:", {
      room_id,
      stopped_by_socket_id: socket.id,
    });
  });

  // socket.on(SocketEvents.LEAVE_ROOM, ({ room_id } = {}) => {
  //   const room = getRoom(room_id);
  //   if (!room) return;

  //   const isUserInRoom = room.users.includes(socket.id);
  //   const isPendingRequest = room.pending_requests.includes(socket.id);

  //   if (!isUserInRoom && !isPendingRequest) return;

  //   if (isPendingRequest && !isUserInRoom) {
  //     const cancelledUser = {
  //       socket_id: socket.id,
  //       user_id: room.user_ids[socket.id] || null,
  //       username: room.usernames[socket.id] || "Guest",
  //       ip: room.user_ips[socket.id] || null,
  //     };

  //     cleanupSocketFromRoom(room, socket.id);

  //     const hostSocket = io.sockets.sockets.get(room.host_id);

  //     if (hostSocket) {
  //       emitEvent(hostSocket, SocketEvents.JOIN_REQUEST_CANCELLED, {
  //         room_id,
  //         ...cancelledUser,
  //         message: "Guest cancelled join request",
  //       });
  //     }

  //     return emitEvent(socket, SocketEvents.JOIN_REQUEST_CANCELLED, {
  //       room_id,
  //       ...cancelledUser,
  //       message: "Join request cancelled",
  //     });
  //   }

  //   if (room.host_id === socket.id) {
  //     if (isMultiPovRoom(room)) {
  //       return destroyMultiPovRoomBecauseHostLeft(
  //         room_id,
  //         room,
  //         socket.id,
  //         "host_left",
  //       );
  //     }

  //     /**
  //      * Existing multiplayer flow remains same.
  //      */
  //     emitDisconnectUnrealClientToRoom(room);
  //     emitResetDedicatedServer(room);

  //     emitEvent(io.to(room_id), SocketEvents.ROOM_CLOSED, {
  //       room_id,
  //       socket_id: socket.id,
  //       user_id: room.user_ids[socket.id] || null,
  //       username: room.usernames[socket.id] || "Host",
  //       message: "Host left the room. Room closed.",
  //     });

  //     const allRoomSocketIds = new Set([
  //       ...(room.users || []),
  //       ...(room.approved_sockets || []),
  //       ...(room.pending_requests || []),
  //     ]);

  //     for (const sid of allRoomSocketIds) {
  //       const roomSocket = io.sockets.sockets.get(sid);

  //       if (roomSocket) {
  //         roomSocket.leave(room_id);

  //         if (roomSocket.room_id === room_id) {
  //           roomSocket.room_id = null;
  //         }

  //         roomSocket.role = null;
  //       }
  //     }

  //     Object.keys(disconnectedUsers).forEach((key) => {
  //       if (disconnectedUsers[key]?.room_id === room_id) {
  //         delete disconnectedUsers[key];
  //       }
  //     });

  //     delete rooms[room_id];

  //     return;
  //   }

  //   handleUserDisconnectFromRoom(room_id, room, socket.id, true, socket);
  // });

  socket.on(SocketEvents.LEAVE_ROOM, ({ room_id } = {}) => {
    const room = getRoom(room_id);
    if (!room) return;

    const isUserInRoom = room.users.includes(socket.id);
    const isPendingRequest = room.pending_requests.includes(socket.id);

    if (!isUserInRoom && !isPendingRequest) return;

    if (isPendingRequest && !isUserInRoom) {
      const cancelledUser = {
        socket_id: socket.id,
        user_id: room.user_ids[socket.id] || null,
        username: room.usernames[socket.id] || "Guest",
        ip: room.user_ips[socket.id] || null,
      };

      cleanupSocketFromRoom(room, socket.id);

      const hostSocket = io.sockets.sockets.get(room.host_id);

      if (hostSocket) {
        emitEvent(hostSocket, SocketEvents.JOIN_REQUEST_CANCELLED, {
          room_id,
          ...cancelledUser,
          message: "Guest cancelled join request",
        });
      }

      return emitEvent(socket, SocketEvents.JOIN_REQUEST_CANCELLED, {
        room_id,
        ...cancelledUser,
        message: "Join request cancelled",
      });
    }

    if (room.host_id === socket.id) {
      if (isMultiPovRoom(room)) {
        return destroyMultiPovRoomBecauseHostLeft(
          room_id,
          room,
          socket.id,
          "host_left",
        );
      }

      /**
       * Existing multiplayer Unreal flow remains same.
       */
      emitDisconnectUnrealClientToRoom(room);
      emitResetDedicatedServer(room);

      /**
       * Important:
       * Notify users + approved users + pending requests directly.
       * Pending users are not joined to Socket.IO room_id yet.
       */
      emitRoomClosedToAllRoomSockets(room_id, room, {
        socket_id: socket.id,
        user_id: room.user_ids[socket.id] || null,
        username: room.usernames[socket.id] || "Host",
        reason: "host_left",
        message: "Host left the room. Room closed.",
      });

      const allRoomSocketIds = new Set([
        ...(room.users || []),
        ...(room.approved_sockets || []),
        ...(room.pending_requests || []),
      ]);

      for (const sid of allRoomSocketIds) {
        const roomSocket = io.sockets.sockets.get(sid);

        if (roomSocket) {
          roomSocket.leave(room_id);

          if (roomSocket.room_id === room_id) {
            roomSocket.room_id = null;
          }

          roomSocket.role = null;
        }
      }

      Object.keys(disconnectedUsers).forEach((key) => {
        if (disconnectedUsers[key]?.room_id === room_id) {
          delete disconnectedUsers[key];
        }
      });

      Object.keys(reconnectCloseTimers).forEach((key) => {
        if (key.startsWith(`${room_id}:`)) {
          clearTimeout(reconnectCloseTimers[key]);
          delete reconnectCloseTimers[key];
        }
      });

      delete rooms[room_id];

      return;
    }

    handleUserDisconnectFromRoom(room_id, room, socket.id, true, socket);
  });

  const saveReconnectData = (
    room_id,
    room,
    disconnectedSocketId,
    socketInstance = null,
  ) => {
    const user_id =
      room.user_ids?.[disconnectedSocketId] || socketInstance?.user_id || null;

    if (!user_id) return false;

    const username =
      room.usernames?.[disconnectedSocketId] ||
      socketInstance?.username ||
      "Unknown";

    const ip =
      room.user_ips?.[disconnectedSocketId] ||
      getNormalizedSocketIp(socketInstance) ||
      null;

    const role =
      room.roles?.[disconnectedSocketId] || socketInstance?.role || "spectator";

    const unrealSocket = findUnrealClientOrSocketByIp(ip, disconnectedSocketId);
    const reconnectKey = getReconnectKey(room_id, user_id);

    if (!reconnectKey) return false;

    disconnectedUsers[reconnectKey] = {
      room_id,
      old_socket_id: disconnectedSocketId,
      username,
      user_id,
      ip,
      role,
      disconnected_at: Date.now(),
      session_started: room.session_started,
      unreal_socket_id: unrealSocket ? unrealSocket.id : null,
    };

    room.disconnected_sockets = room.disconnected_sockets || {};

    room.disconnected_sockets[disconnectedSocketId] = {
      user_id,
      username,
      role,
      disconnected_at: Date.now(),
    };

    return reconnectKey;
  };

  function handleUserDisconnectFromRoom(
    room_id,
    room,
    disconnectedSocketId,
    isManualLeave = false,
    socketInstance = null,
  ) {
    const username =
      room.usernames[disconnectedSocketId] ||
      socketInstance?.username ||
      "Unknown";

    const user_id =
      room.user_ids[disconnectedSocketId] || socketInstance?.user_id || null;

    const role =
      room.roles[disconnectedSocketId] || socketInstance?.role || "spectator";

    if (isManualLeave) {
      if (isMultiPovRoom(room) && role === "spectator") {
        emitDeletePlayerToMultiPovUnreal(room, disconnectedSocketId);
      } else {
        notifyPairedUnrealForFeDisconnect(
          room,
          disconnectedSocketId,
          true,
          socketInstance,
        );
      }

      cleanupSocketFromRoom(room, disconnectedSocketId);

      emitEvent(io.to(room_id), SocketEvents.USER_LEFT, {
        room_id,
        socket_id: disconnectedSocketId,
        user_id,
        username,
        role,
        message: "User left the room",
        user_count: room.users.length,
      });

      return;
    }

    if (!user_id) return;

    const didSaveReconnect = saveReconnectData(
      room_id,
      room,
      disconnectedSocketId,
      socketInstance,
    );

    if (!didSaveReconnect) return;

    scheduleUnrealCloseAfterReconnectWindow(
      room_id,
      room,
      disconnectedSocketId,
      socketInstance,
    );

    room.disconnected_sockets = room.disconnected_sockets || {};

    room.disconnected_sockets[disconnectedSocketId] = {
      user_id,
      username,
      role,
      disconnected_at: Date.now(),
    };

    const current_users = getUserList(room);

    emitEvent(
      io.to(room_id),
      SocketEvents.USER_DISCONNECTED_TEMPORARY || "user_disconnected_temporary",
      {
        room_id,
        socket_id: disconnectedSocketId,
        user_id,
        username,
        role,
        users: current_users,
        reconnect_window_ms: RECONNECT_WINDOW_MS,
        message: "User temporarily disconnected. Waiting for reconnect.",
      },
    );
  }

  // socket.on(SocketEvents.DISCONNECT, (reason) => {
  //   const socketUserId = socket.user_id || null;
  //   const socketIp = getNormalizedSocketIp(socket);

  //   console.log("Socket disconnected:", {
  //     socket_id: socket.id,
  //     reason,
  //     is_frontend: isFrontendSocket(socket),
  //     is_unreal_client: socket.is_unreal_client,
  //     is_unreal_socket: socket.is_unreal_socket,
  //     is_unreal_multipov_instance: socket.is_unreal_multipov_instance,
  //     is_dedicated_server: isDedicatedServerSocket(socket),
  //     user_id: socketUserId || socket.unreal_user_id || null,
  //     ip: socketIp,
  //   });

  //   clearActiveDedicatedServerIfSocketMatches(socket.id);

  //   if (isDedicatedServerSocket(socket)) {
  //     return;
  //   }

  //   if (socket.is_unreal_multipov_instance) {
  //     const ip = socket.multipov_ip || getNormalizedSocketIp(socket);
  //     const key = getMultiPovKey(ip);

  //     if (key && multiPovUnrealInstances[key]?.socket_id === socket.id) {
  //       delete multiPovUnrealInstances[key];
  //     }

  //     Object.values(rooms).forEach((room) => {
  //       if (room.host_multipov_socket_id === socket.id) {
  //         room.host_multipov_socket_id = null;
  //         room.host_multipov_ip = null;
  //       }
  //     });

  //     console.log("Multi POV Unreal instance disconnected:", {
  //       socket_id: socket.id,
  //       ip,
  //     });

  //     return;
  //   }

  //   if (isPairedUnrealSocket(socket)) {
  //     notifyPairedFeForUnrealDisconnect(socket);
  //     return;
  //   }

  //   Object.entries(rooms).forEach(([room_id, room]) => {
  //     const isInUsers = room.users.includes(socket.id);
  //     const isInPending = room.pending_requests.includes(socket.id);
  //     const isInApproved = room.approved_sockets.includes(socket.id);
  //     const isCurrentHost = room.host_id === socket.id;

  //     if (!isInUsers && !isInPending && !isInApproved && !isCurrentHost) {
  //       return;
  //     }

  //     if (isCurrentHost) {
  //       const oldHostSnapshot = {
  //         socket_id: socket.id,
  //         user_id:
  //           room.user_ids?.[socket.id] ||
  //           room.host_user_id ||
  //           socket.user_id ||
  //           null,
  //         username:
  //           room.usernames?.[socket.id] ||
  //           socket.username ||
  //           "Host",
  //         ip: normalizeIp(
  //           room.user_ips?.[socket.id] ||
  //           room.host_ip ||
  //           getNormalizedSocketIp(socket),
  //         ),
  //       };

  //       if (isMultiPovRoom(room)) {
  //         emitCloseUnrealToMultiPovRoom(room);

  //         return closeRoom(room_id, room, {
  //           socket_id: socket.id,
  //           user_id: oldHostSnapshot.user_id,
  //           username: oldHostSnapshot.username,
  //           ip: oldHostSnapshot.ip,
  //           message: "Multi POV host disconnected. Room closed.",
  //         });
  //       }

  //       saveReconnectData(room_id, room, socket.id, socket);

  //       notifyPairedUnrealForFeDisconnect(
  //         room,
  //         socket.id,
  //         false,
  //         socket,
  //       );

  //       promoteRandomHostAfterHostLeft(
  //         room_id,
  //         room,
  //         socket.id,
  //         false,
  //         oldHostSnapshot,
  //       );

  //       return;
  //     }

  //     if (!isMultiPovRoom(room)) {
  //       notifyPairedUnrealForFeDisconnect(
  //         room,
  //         socket.id,
  //         false,
  //         socket,
  //       );
  //     }

  //     handleUserDisconnectFromRoom(
  //       room_id,
  //       room,
  //       socket.id,
  //       false,
  //       socket,
  //     );
  //   });
  // });
  const emitDeletePlayersForAllMultiPovUsers = (room) => {
    if (!room || !isMultiPovRoom(room)) return false;

    const streamerIds = Array.from(
      new Set([...(room.approved_sockets || []), ...(room.users || [])]),
    ).filter((sid) => {
      return !!sid && room.roles?.[sid];
    });

    if (streamerIds.length === 0) {
      console.log("No Multi POV streamers found for bulk delete_player:", {
        room_id: room?.room_id,
      });

      return false;
    }

    let emittedCount = 0;

    for (const streamerId of streamerIds) {
      const didEmit = emitDeletePlayerToMultiPovUnreal(room, streamerId);

      if (didEmit) {
        emittedCount += 1;
      }
    }

    console.log("Multi POV delete_player emitted for all streamers:", {
      room_id: room.room_id,
      streamer_count: streamerIds.length,
      emitted_count: emittedCount,
      streamer_ids: streamerIds,
    });

    return emittedCount > 0;
  };

  socket.on(SocketEvents.DISCONNECT, (reason) => {
    const socketUserId = socket.user_id || null;
    const socketIp = getNormalizedSocketIp(socket);

    console.log("Socket disconnected:", {
      socket_id: socket.id,
      reason,
      is_frontend: isFrontendSocket(socket),
      is_unreal_client: socket.is_unreal_client,
      is_unreal_socket: socket.is_unreal_socket,
      is_unreal_multipov_instance: socket.is_unreal_multipov_instance,
      is_dedicated_server: isDedicatedServerSocket(socket),
      user_id: socketUserId || socket.unreal_user_id || null,
      ip: socketIp,
    });

    clearActiveDedicatedServerIfSocketMatches(socket.id);

    /**
     * Dedicated server disconnected.
     * Do not run FE room handling.
     */
    if (isDedicatedServerSocket(socket)) {
      return;
    }

    /**
     * Multi POV Unreal instance disconnected.
     * Remove it from active Multi POV cache and clear room references.
     */
    if (socket.is_unreal_multipov_instance) {
      const ip = socket.multipov_ip || getNormalizedSocketIp(socket);
      const key = getMultiPovKey(ip);

      if (key && multiPovUnrealInstances[key]?.socket_id === socket.id) {
        delete multiPovUnrealInstances[key];
      }

      Object.values(rooms).forEach((room) => {
        if (room.host_multipov_socket_id === socket.id) {
          room.host_multipov_socket_id = null;
          room.host_multipov_ip = null;
        }
      });

      console.log("Multi POV Unreal instance disconnected:", {
        socket_id: socket.id,
        ip,
      });

      return;
    }

    /**
     * Normal multiplayer Unreal client/socket disconnected.
     * Keep existing multiplayer behavior.
     */
    if (isPairedUnrealSocket(socket)) {
      notifyPairedFeForUnrealDisconnect(socket);
      return;
    }

    /**
     * FE socket disconnected.
     */
    Object.entries(rooms).forEach(([room_id, room]) => {
      const isInUsers = room.users.includes(socket.id);
      const isInPending = room.pending_requests.includes(socket.id);
      const isInApproved = room.approved_sockets.includes(socket.id);
      const isCurrentHost = room.host_id === socket.id;

      if (!isInUsers && !isInPending && !isInApproved && !isCurrentHost) {
        return;
      }

      /**
       * HOST DISCONNECT
       */
      if (isCurrentHost) {
        const oldHostSnapshot = {
          socket_id: socket.id,
          user_id:
            room.user_ids?.[socket.id] ||
            room.host_user_id ||
            socket.user_id ||
            null,
          username: room.usernames?.[socket.id] || socket.username || "Host",
          ip: normalizeIp(
            room.user_ips?.[socket.id] ||
              room.host_ip ||
              getNormalizedSocketIp(socket),
          ),
        };

        /**
         * Multi POV:
         * Host disconnected.
         *
         * Required behavior:
         * 1. Send delete_player for every streamer/player in the room.
         *    Example: 4 players => 4 delete_player emits.
         * 2. Send close_unreal to host Multi POV Unreal instance.
         * 3. Notify frontend that room is closed.
         * 4. Clear room sockets/cache/timers.
         * 5. Delete room.
         *
         * Do NOT run multiplayer reconnect/promotion flow.
         */
        if (isMultiPovRoom(room)) {
          emitDeletePlayersForAllMultiPovUsers(room);

          emitCloseUnrealToMultiPovRoom(room);

          emitEvent(io.to(room_id), SocketEvents.ROOM_CLOSED, {
            room_id,
            socket_id: socket.id,
            user_id: oldHostSnapshot.user_id,
            username: oldHostSnapshot.username,
            ip: oldHostSnapshot.ip,
            reason: "host_disconnected",
            message: "Multi POV host disconnected. Room closed.",
          });

          const allRoomSocketIds = new Set([
            ...(room.users || []),
            ...(room.approved_sockets || []),
            ...(room.pending_requests || []),
          ]);

          for (const sid of allRoomSocketIds) {
            const roomSocket = io.sockets.sockets.get(sid);

            if (roomSocket) {
              roomSocket.leave(room_id);

              if (roomSocket.room_id === room_id) {
                roomSocket.room_id = null;
              }

              roomSocket.role = null;
            }
          }

          Object.keys(disconnectedUsers).forEach((key) => {
            if (disconnectedUsers[key]?.room_id === room_id) {
              delete disconnectedUsers[key];
            }
          });

          Object.keys(reconnectCloseTimers).forEach((key) => {
            if (key.startsWith(`${room_id}:`)) {
              clearTimeout(reconnectCloseTimers[key]);
              delete reconnectCloseTimers[key];
            }
          });

          delete rooms[room_id];

          console.log("Multi POV room destroyed because host disconnected:", {
            room_id,
            host_socket_id: socket.id,
            host_user_id: oldHostSnapshot.user_id,
            host_ip: oldHostSnapshot.ip,
          });

          return;
        }

        /**
         * Multiplayer:
         * Existing flow remains same.
         */
        saveReconnectData(room_id, room, socket.id, socket);

        // notifyPairedUnrealForFeDisconnect(
        //   room,
        //   socket.id,
        //   false,
        //   socket,
        // );

        scheduleUnrealCloseAfterReconnectWindow(
          room_id,
          room,
          socket.id,
          socket,
        );

        promoteRandomHostAfterHostLeft(
          room_id,
          room,
          socket.id,
          false,
          oldHostSnapshot,
        );

        return;
      }

      /**
       * NON-HOST / SPECTATOR DISCONNECT
       */

      /**
       * Multi POV:
       * Spectator disconnected.
       *
       * Required behavior:
       * Send delete_player only once for this disconnected spectator.
       */
      if (isMultiPovRoom(room)) {
        const role = room.roles?.[socket.id] || socket.role || "spectator";

        if (role === "spectator") {
          emitDeletePlayerToMultiPovUnreal(room, socket.id);
        }

        /**
         * Keep your existing temporary disconnect/reconnect handling.
         * If you do not want reconnect for Multi POV spectators,
         * replace this with cleanupSocketFromRoom(...) + USER_LEFT emit.
         */
        handleUserDisconnectFromRoom(room_id, room, socket.id, false, socket);

        return;
      }

      /**
       * Multiplayer:
       * Existing flow remains same.
       */
      notifyPairedUnrealForFeDisconnect(room, socket.id, false, socket);

      handleUserDisconnectFromRoom(room_id, room, socket.id, false, socket);
    });
  });

  socket.on(SocketEvents.REGISTER_UNREAL_CLIENT, (payload = {}) => {
    const eventData = payload.data || payload;

    const { user_id, client_ip } = eventData || {};

    socket.is_unreal_client = true;
    socket.unreal_user_id = user_id || null;
    socket.client_ip = normalizeIp(client_ip) || getNormalizedSocketIp(socket);

    const responsePayload = {
      success: true,
      socket_id: socket.id,
      user_id: socket.unreal_user_id,
      client_ip: socket.client_ip,
      message: "Unreal client registered successfully",
    };

    emitEvent(socket, SocketEvents.UNREAL_REGISTERED, {
      socket_id: socket.id,
      user_id: socket.unreal_user_id,
      client_ip: socket.client_ip,
      message: "Unreal client registered successfully",
    });

    return emitEvent(
      socket,
      SocketEvents.UNREAL_CLIENT_REGISTERD_SUCCESSFULLY,
      responsePayload,
    );
  });

  socket.on(
    SocketEvents.UNREAL_SOCKET_CONNECTION_ESTABLISHED,
    ({ ip, port } = {}) => {
      const normalizedIp = normalizeIp(ip) || getNormalizedSocketIp(socket);

      socket.is_unreal_socket = true;
      socket.unreal_ip = normalizedIp;
      socket.unreal_port = port || null;

      emitEvent(socket, SocketEvents.UNREAL_HOST_REGISTERED, {
        message: "Unreal socket registered successfully",
        ip: normalizedIp,
        port: socket.unreal_port,
        socket_id: socket.id,
      });
    },
  );

  socket.on(
    SocketEvents.REGISTER_UNREAL_MULTIPOV_INSTANCE ||
      "register_unreal_multipov_instance",
    () => {
      const ip = getNormalizedSocketIp(socket);

      if (!ip) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Unable to detect socket IP for Multi POV Unreal instance",
        });
      }

      socket.is_unreal_multipov_instance = true;
      socket.multipov_ip = ip;

      socket.is_unreal_client = false;
      socket.is_unreal_socket = false;

      const key = getMultiPovKey(ip);

      multiPovUnrealInstances[key] = {
        key,
        socket_id: socket.id,
        ip,
        connected_at: Date.now(),
      };

      console.log("REGISTER_UNREAL_MULTIPOV_INSTANCE:", {
        key,
        socket_id: socket.id,
        ip,
      });

      return emitEvent(
        socket,
        SocketEvents.UNREAL_MULTIPOV_INSTANCE_REGISTERED ||
          "unreal_multipov_instance_registered",
        {
          success: true,
          socket_id: socket.id,
          ip,
          message: "Unreal Multi POV instance registered successfully",
        },
      );
    },
  );

  socket.on(
    SocketEvents.CREATE_PLAYER_REVERT || "create_player_revert",
    (payload = {}) => {
      console.log("create player revert called", payload);

      const eventData = payload.data || payload;
      const { status } = eventData || {};

      if (status !== "success" && status !== "failure") {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: 'status must be either "success" or "failure"',
        });
      }

      const multipovIp = socket.multipov_ip || getNormalizedSocketIp(socket);

      const room = Object.values(rooms).find((r) => {
        if (!isMultiPovRoom(r)) return false;

        if (r.host_multipov_socket_id === socket.id) return true;

        return (
          normalizeIp(r.host_multipov_ip || r.host_ip) ===
          normalizeIp(multipovIp)
        );
      });

      if (!room) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Room not found for create_player_revert",
        });
      }

      /**
       * Unreal sends only status, so take the oldest pending create_player.
       */
      room.pending_create_players = room.pending_create_players || [];

      const pendingCreatePlayer = room.pending_create_players.shift() || null;

      const streamer_id =
        eventData.streamer_id || pendingCreatePlayer?.streamer_id || null;

      if (!streamer_id) {
        return emitEvent(socket, SocketEvents.ERROR, {
          room_id: room.room_id,
          message: "streamer_id not found for create_player_revert",
        });
      }

      const role =
        pendingCreatePlayer?.role ||
        room.roles?.[streamer_id] ||
        (streamer_id === room.host_id ? "prime" : "spectator");

      const responsePayload = {
        room_id: room.room_id,
        status,
        streamer_id,
        role,
        host_id: room.host_id,
        session_type: room.session_type,
        mid_session_join: pendingCreatePlayer?.mid_session_join || false,
        unreal_pov_instance: {
          socket_id: socket.id,
          ip:
            socket.multipov_ip ||
            room.host_multipov_ip ||
            room.host_ip ||
            multipovIp ||
            null,
        },
        message:
          status === "success"
            ? "Player created successfully"
            : "Player creation failed",
      };

      /**
       * Send ONLY to the frontend socket that belongs to streamer_id.
       */
      if (status === "success") {
        return emitEvent(
          io.to(streamer_id),
          SocketEvents.CREATE_PLAYER_SUCCESS || "create_player_success",
          responsePayload,
        );
      }

      return emitEvent(
        io.to(streamer_id),
        SocketEvents.CREATE_PLAYER_FAILED || "create_player_failed",
        responsePayload,
      );
    },
  );

  socket.on(
    SocketEvents.CHANGE_GAME_MODE,
    ({ room_id, map_name, no_of_cubes, game_mode = "Player" } = {}) => {
      const room = getRoom(room_id);

      if (!room) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Room not found",
        });
      }

      if (room.host_id !== socket.id) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Unauthorized: Only current host can change game mode",
        });
      }

      if (!no_of_cubes) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "no_of_cubes is required",
        });
      }

      applyActiveDedicatedServerToRoom(room);

      if (room.session_type != "multipov") {
        if (!room.dedicated_server_socket_id) {
          return emitEvent(socket, SocketEvents.ERROR, {
            message: "Dedicated server is not registered",
          });
        }
      }

      if (room.game_mode_changing) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Game mode change already in progress",
        });
      }

      room.game_mode_changing = true;
      room.game_mode_request_id = crypto.randomUUID();
      room.pending_game_mode = game_mode;
      room.max_cubes = Number(no_of_cubes) || room.max_cubes;

      emitEvent(io.to(room_id), SocketEvents.GAME_MODE_CHANGING, {
        room_id,
        request_id: room.game_mode_request_id,
        map_name,
        no_of_cubes,
        game_mode,
        message: `Game mode is changing to ${game_mode}`,
      });

      if (isMultiPovRoom(room)) {
        emitToMultiPovRoomUnreal(
          room,
          SocketEvents.UNREAL_CHANGE_MAP || "unreal_change_map",
          {
            room_id,
            request_id: room.game_mode_request_id,
            game_mode,
            no_of_cubes,
          },
        );

        return;
      }

      emitEvent(
        io.to(room.dedicated_server_socket_id),
        SocketEvents.UNREAL_CHANGE_MAP,
        {
          room_id,
          request_id: room.game_mode_request_id,
          socket_id: socket.id,
          map_name,
          no_of_cubes,
          game_mode,
          message: "Change game mode requested",
        },
      );
    },
  );

  socket.on(SocketEvents.CHANGE_GAME_MODE_REQUESTED_REVERT, ({ data } = {}) => {
    const {
      room_id,
      request_id,
      status,
      game_mode,
      error_code,
      error_message,
    } = data || {};

    console.log(">>>>>>>CHANGE_GAME_MODE_REQUESTED_REVERT>>>>>>");

    if (status !== "success" && status !== "failure") {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: 'status must be either "success" or "failure"',
      });
    }

    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (!room.game_mode_changing) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "No game mode change is currently in progress",
      });
    }

    if (room.game_mode_request_id !== request_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Invalid or expired game mode request_id",
      });
    }

    if (status === "success") {
      room.game_mode = game_mode || room.pending_game_mode;
      room.game_mode_changing = false;
      room.game_mode_request_id = null;
      room.pending_game_mode = null;

      return emitEvent(io.to(room_id), SocketEvents.GAME_MODE_CHANGED, {
        room_id,
        game_mode: room.game_mode,
        message: `Game mode changed successfully to ${room.game_mode}`,
      });
    }

    room.game_mode_changing = false;
    room.game_mode_request_id = null;
    room.pending_game_mode = null;

    return emitEvent(io.to(room_id), SocketEvents.GAME_MODE_CHANGE_FAILED, {
      room_id,
      error_code: error_code || null,
      message: error_message || "Failed to change game mode",
    });
  });

  socket.on(SocketEvents.SPAWN_CUBE, ({ room_id, streamer_id } = {}) => {
    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (!room.game_mode || room.game_mode !== "Player") {
      return emitEvent(io.to(room_id), SocketEvents.ERROR, {
        message: "Cube spawn is only allowed in player mode",
      });
    }

    if (room.cube_spawn_in_progress) {
      return emitEvent(io.to(room_id), SocketEvents.ERROR, {
        message: "Cube spawn already in progress",
      });
    }

    const userId = room.user_ids[socket.id];
    const username = room.usernames[socket.id] || "Guest";

    if (!userId && socket.id !== room.host_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "User not found in room",
      });
    }

    if (room.max_cubes !== null && room.spawned_cubes >= room.max_cubes) {
      return emitEvent(socket, SocketEvents.CUBE_SPAWN_FAILED, {
        room_id,
        error_code: "MAX_CUBE_LIMIT_REACHED",
        message: "Max cube limit reached",
      });
    }

    room.cube_spawn_in_progress = true;
    room.cube_spawn_request_id = crypto.randomUUID();
    room.cube_spawn_requested_by = socket.id;

    if (isMultiPovRoom(room)) {
      const didEmit = emitToMultiPovRoomUnreal(
        room,
        SocketEvents.SPAWN_CUBE_REQUESTED || "spawn_cube_requested",
        {
          room_id,
          request_id: room.cube_spawn_request_id,
          socket_id: socket.id,
          user_id: userId,
          username,
          streamer_id,
        },
      );

      if (!didEmit) {
        room.cube_spawn_in_progress = false;
        room.cube_spawn_request_id = null;
        room.cube_spawn_requested_by = null;

        return emitEvent(socket, SocketEvents.CUBE_SPAWN_FAILED, {
          room_id,
          error_code: "MULTIPOV_UNREAL_SOCKET_NOT_FOUND",
          message: "No host Multi POV Unreal instance found",
        });
      }

      return;
    }

    const requesterIp = getNormalizedSocketIp(socket);

    const unrealSocket = findUnrealClientOrSocketByIp(requesterIp, socket.id);

    if (unrealSocket) {
      emitEvent(io.to(unrealSocket.id), SocketEvents.SPAWN_CUBE_REQUESTED, {
        room_id,
        request_id: room.cube_spawn_request_id,
        socket_id: socket.id,
        user_id: userId,
        username,
      });
    } else {
      room.cube_spawn_in_progress = false;
      room.cube_spawn_request_id = null;
      room.cube_spawn_requested_by = null;

      return emitEvent(socket, SocketEvents.CUBE_SPAWN_FAILED, {
        room_id,
        error_code: "UNREAL_SOCKET_NOT_FOUND",
        message: "No matching Unreal socket found for this user",
      });
    }
  });

  socket.on(SocketEvents.SPAWN_CUBE_REQUESTED_REVERT, ({ data } = {}) => {
    const {
      room_id,
      request_id,
      status,
      error_code,
      error_message,
      cube_count,
    } = data || {};

    if (!room_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "room_id and request_id are required",
      });
    }

    if (status !== "success" && status !== "failure") {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: 'status must be either "success" or "failure"',
      });
    }

    const room = getRoom(room_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found",
      });
    }

    if (!room.cube_spawn_in_progress) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "No cube spawn is currently in progress",
      });
    }

    if (status === "success") {
      room.spawned_cubes = cube_count || (room.spawned_cubes || 0) + 1;
      room.cube_spawn_in_progress = false;
      room.cube_spawn_request_id = null;
      room.cube_spawn_requested_by = null;

      return emitEvent(io.to(room_id), SocketEvents.CUBE_SPAWNED, {
        room_id,
        spawned_cubes: room.spawned_cubes,
        max_cubes: room.max_cubes,
        message: "Cube spawned successfully",
        cube_count,
      });
    }

    room.cube_spawn_in_progress = false;
    room.cube_spawn_request_id = null;
    room.cube_spawn_requested_by = null;

    return emitEvent(io.to(room_id), SocketEvents.CUBE_SPAWN_FAILED, {
      room_id,
      error_code: error_code || null,
      message: error_message || "Cube spawn failed",
    });
  });

  socket.on(SocketEvents.REGISTER_UNREAL_SERVER, ({ user_id } = {}) => {
    const room = getRoomByHostUserId(user_id);

    if (!room) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room not found for this host user",
      });
    }

    room.unreal_server_socket_id = socket.id;
    room.unreal_user_id = user_id;

    emitEvent(socket, SocketEvents.UNREAL_SERVER_REGISTERED, {
      room_id: room.room_id,
      socket_id: socket.id,
      message: "Unreal server registered successfully",
    });
  });

  socket.on(
    SocketEvents.UNREAL_SERVER_SOCKET_CONNECTION_ESTABLISHED,
    ({ ip, port } = {}) => {
      const normalizedIp = normalizeIp(ip) || getNormalizedSocketIp(socket);

      socket.is_unreal_server_socket = true;
      socket.is_unreal_dedicated_server = true;
      socket.unreal_server_ip = normalizedIp;
      socket.unreal_server_port = port || null;
      socket.dedicated_server_ip = normalizedIp;
      socket.dedicated_server_port = port || null;

      activeUnrealServer = {
        socket_id: socket.id,
        ip: normalizedIp,
        port: port || null,
      };

      Object.values(rooms).forEach(applyActiveDedicatedServerToRoom);

      emitEvent(socket, SocketEvents.UNREAL_SERVER_SOCKET_REGISTERED, {
        message: "Unreal server socket registered successfully",
        ip: normalizedIp,
        port: socket.unreal_server_port,
        socket_id: socket.id,
      });
    },
  );

  socket.on(SocketEvents.UPDATE_FE_LISTENPORT, ({ player_port } = {}) => {
    const unrealIp = getNormalizedSocketIp(socket);

    if (!player_port) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "player_port is required",
      });
    }

    if (!socket.is_unreal_socket) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Only Unreal socket can emit update_fe_listenport",
      });
    }

    let matchedFeSocket = null;

    for (const s of io.sockets.sockets.values()) {
      const currentIp = getNormalizedSocketIp(s);

      if (
        s.id !== socket.id &&
        s.is_unreal_socket !== true &&
        s.is_unreal_client !== true &&
        s.is_unreal_multipov_instance !== true &&
        s.is_unreal_server_socket !== true &&
        s.is_unreal_dedicated_server !== true &&
        currentIp === unrealIp
      ) {
        matchedFeSocket = s;
        break;
      }
    }

    if (!matchedFeSocket) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "No matching FE socket found on same IP",
      });
    }

    emitEvent(matchedFeSocket, SocketEvents.FE_LISTENPORT_UPDATED, {
      player_port,
      ip: unrealIp,
      unreal_socket_id: socket.id,
      fe_socket_id: matchedFeSocket.id,
      message: "Player port received from Unreal and sent to matching FE",
    });
  });

  socket.on(SocketEvents.REGISTER_UNREAL_DEDICATED_SERVER, (payload = {}) => {
    const eventData = payload.data || payload;

    const { dedicated_server_ip, dedicated_server_port } = eventData || {};

    const normalizedIp = normalizeIp(dedicated_server_ip);
    const normalizedPort = String(dedicated_server_port).trim();

    socket.is_unreal_dedicated_server = true;
    socket.is_unreal_server_socket = true;
    socket.dedicated_server_ip = normalizedIp;
    socket.dedicated_server_port = normalizedPort;
    socket.unreal_server_ip = normalizedIp;
    socket.unreal_server_port = normalizedPort;

    activeUnrealServer = {
      socket_id: socket.id,
      ip: normalizedIp,
      port: normalizedPort,
    };

    Object.values(rooms).forEach(applyActiveDedicatedServerToRoom);

    const responsePayload = {
      success: true,
      socket_id: socket.id,
      dedicated_server_ip: normalizedIp,
      dedicated_server_port: normalizedPort,
    };

    return emitEvent(
      socket,
      SocketEvents.UNREAL_DEDICATED_SERVER_REGISTERD_SUCCESSFULLY,
      responsePayload,
    );
  });

  socket.on(SocketEvents.UNREAL_SOCKET_RECONNECTION, () => {
    socket.is_unreal_socket = true;
    socket.unreal_should_reconnect = true;

    const JOIN_SERVER_EVENT = SocketEvents.JOIN_SERVER || "join_server";

    const dedicatedServerIp = activeUnrealServer?.ip || null;
    const dedicatedServerPort = activeUnrealServer?.port || null;

    emitEvent(socket, JOIN_SERVER_EVENT, {
      server_ip: dedicatedServerIp,
      server_port: dedicatedServerPort,
      role: "spectator",
      message: "unreal reconnected successfully",
      username: socket.username,
    });
  });

  socket.on(SocketEvents.REJOIN_ROOM, ({ user_id, room_id } = {}) => {
    const reconnectKey = getReconnectKey(room_id, user_id);
    let reconnectData = reconnectKey ? disconnectedUsers[reconnectKey] : null;
    const rejoinIp = getNormalizedSocketIp(socket);

    if (!user_id || !room_id) {
      return emitEvent(socket, SocketEvents.ERROR, {
        message: "user_id and room_id are required",
        code: "REJOIN_INVALID_PAYLOAD",
      });
    }

    if (reconnectData) {
      const reconnectAge = Date.now() - reconnectData.disconnected_at;

      if (reconnectAge > RECONNECT_WINDOW_MS) {
        const timeoutIp = normalizeIp(reconnectData.ip || rejoinIp);

        const timeoutRoom = getRoom(reconnectData.room_id);

        if (timeoutRoom && isMultiPovRoom(timeoutRoom)) {
          emitDeletePlayerToMultiPovUnreal(
            timeoutRoom,
            reconnectData.old_socket_id,
          );
        } else {
          const unrealSocket = findUnrealClientOrSocketByIp(
            timeoutIp,
            socket.id,
          );

          if (unrealSocket) {
            emitCloseConnectionToSocket(unrealSocket, {
              room_id: reconnectData.room_id,
              source: "backend",
              target: "unreal",
              reason: "reconnect_timeout",
              user_id: reconnectData.user_id,
              username: reconnectData.username,
              role: reconnectData.role,
              ip: timeoutIp,
              fe_socket_id: socket.id,
              old_fe_socket_id: reconnectData.old_socket_id,
              unreal_socket_id: unrealSocket.id,
              reconnect_age_ms: reconnectAge,
              reconnect_window_ms: RECONNECT_WINDOW_MS,
              message: "Reconnect time expired. Close Unreal on same IP.",
            });
          }
        }

        if (reconnectCloseTimers?.[reconnectKey]) {
          clearTimeout(reconnectCloseTimers[reconnectKey]);
          delete reconnectCloseTimers[reconnectKey];
        }

        delete disconnectedUsers[reconnectKey];

        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Reconnect time expired",
          code: "RECONNECT_TIMEOUT",
          reconnect_age_ms: reconnectAge,
          reconnect_window_ms: RECONNECT_WINDOW_MS,
        });
      }
    }

    const existingRoom = getRoom(room_id);

    if (existingRoom) {
      const alreadyCurrentSocket =
        existingRoom.users.includes(socket.id) &&
        String(existingRoom.user_ids[socket.id]) === String(user_id);

      if (alreadyCurrentSocket) {
        const current_users = getUserList(existingRoom);

        return emitEvent(socket, SocketEvents.SESSION_STARTED, {
          room_id,
          socket_id: socket.id,
          server_ip: existingRoom.dedicated_server_ip,
          server_port: existingRoom.dedicated_server_port,
          role: existingRoom.roles[socket.id] || "spectator",
          reconnect: true,
          users: current_users,
          spawned_cubes: existingRoom.spawned_cubes,
          host: {
            socket_id: existingRoom.host_id,
            user_id: existingRoom.host_user_id,
            username: existingRoom.usernames[existingRoom.host_id] || "Host",
          },
          message: "Already reconnected",
        });
      }
    }

    if (!reconnectData) {
      const fallbackRoom = getRoom(room_id);

      if (!fallbackRoom) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "Room no longer exists",
          code: "ROOM_CLOSED",
        });
      }

      const oldSocketId = Object.keys(fallbackRoom.user_ids || {}).find(
        (sid) => {
          return String(fallbackRoom.user_ids[sid]) === String(user_id);
        },
      );

      if (!oldSocketId) {
        return emitEvent(socket, SocketEvents.ERROR, {
          message: "No reconnection session found",
          code: "RECONNECT_NOT_FOUND",
          debug: {
            user_id,
            room_id,
            socket_id: socket.id,
            available_user_ids: fallbackRoom.user_ids,
            users: fallbackRoom.users,
            approved_sockets: fallbackRoom.approved_sockets,
          },
        });
      }

      reconnectData = {
        room_id,
        old_socket_id: oldSocketId,
        username: fallbackRoom.usernames[oldSocketId] || "Unknown",
        user_id,
        ip: fallbackRoom.user_ips[oldSocketId] || null,
        role: fallbackRoom.roles[oldSocketId] || "spectator",
        disconnected_at: Date.now(),
        session_started: fallbackRoom.session_started,
      };

      if (reconnectKey) {
        disconnectedUsers[reconnectKey] = reconnectData;

        if (reconnectCloseTimers[reconnectKey]) {
          clearTimeout(reconnectCloseTimers[reconnectKey]);
          delete reconnectCloseTimers[reconnectKey];
        }
      }
    }

    const room = getRoom(reconnectData.room_id);

    if (!room) {
      delete disconnectedUsers[reconnectKey];

      return emitEvent(socket, SocketEvents.ERROR, {
        message: "Room no longer exists",
        code: "ROOM_CLOSED",
      });
    }

    const oldSocketId = reconnectData.old_socket_id;

    room.users = room.users.filter((id) => id !== oldSocketId);
    room.approved_sockets = room.approved_sockets.filter(
      (id) => id !== oldSocketId,
    );
    room.pending_requests = room.pending_requests.filter(
      (id) => id !== oldSocketId,
    );

    delete room.usernames[oldSocketId];
    delete room.user_ids[oldSocketId];
    delete room.user_ips[oldSocketId];
    delete room.roles[oldSocketId];

    if (room.disconnected_sockets) {
      delete room.disconnected_sockets[oldSocketId];
    }

    if (!room.users.includes(socket.id)) {
      room.users.push(socket.id);
    }

    if (!room.approved_sockets.includes(socket.id)) {
      room.approved_sockets.push(socket.id);
    }

    room.usernames[socket.id] = reconnectData.username;
    room.user_ids[socket.id] = reconnectData.user_id;
    room.user_ips[socket.id] = rejoinIp;
    room.roles[socket.id] = reconnectData.role;

    socket.user_id = reconnectData.user_id;
    socket.username = reconnectData.username;
    socket.role = reconnectData.role;
    socket.is_frontend = true;

    if (reconnectData.role === "prime") {
      room.roles[socket.id] = "spectator";
      socket.role = "spectator";
    }

    socket.join(room.room_id);

    if (reconnectKey && reconnectCloseTimers[reconnectKey]) {
      clearTimeout(reconnectCloseTimers[reconnectKey]);
      delete reconnectCloseTimers[reconnectKey];
    }

    if (reconnectKey) {
      delete disconnectedUsers[reconnectKey];
    }

    const current_users = getUserList(room);

    return emitEvent(socket, SocketEvents.USER_REJOINED, {
      room_id: room.room_id,
      socket_id: socket.id,
      server_ip: room.dedicated_server_ip,
      server_port: room.dedicated_server_port,
      spwaned_cubes: room.spawned_cubes,
      role: "spectator",
      reconnect: true,
      users: current_users,
      game_mode: room.game_mode,
      host: {
        socket_id: room.host_id,
        user_id: room.host_user_id,
        username: room.usernames[room.host_id] || "Host",
      },
      message: "React reconnected successfully",
    });
  });
};
