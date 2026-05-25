/**
 * Socket.io Event Constants
 */
const SocketEvents = {
  // Generic
  ERROR: "error",
  BACKEND_EVENT: "backend_event",
  DISCONNECT: "disconnect",

  // Room Events
  CREATE_ROOM: "create_room",
  ROOM_CREATED: "room_created",
  ROOM_CLOSED: "room_closed",
  HOST_REASSIGNED: "host_reassigned",
  LEAVE_ROOM: "leave_room",
  JOIN_ROOM_REQUEST: "join_room_request",
  JOIN_REQUEST: "join_request",
  JOIN_REQUEST_SENT: "join_request_sent",
  JOIN_REQUEST_FAILED: "join_request_failed",
  APPROVE_USER: "approve_user",
  REJECT_USER: "reject_user",
  JOIN_APPROVED: "join_approved",
  JOIN_REJECTED: "join_rejected",
  USER_JOINED: "user_joined",
  USER_JOINED_ROOM: "user_join_room",
  USER_LEFT: "user_left",

  // Session Events
  START_SESSION: "start_session",
  STOP_SESSION: "stop_session",
  SESSION_STARTING: "session_starting",
  JOIN_SERVER: "join_server",
  SESSION_STARTED: "session_started",
  USER_REJOINED: "user_rejoined",
  PLAYER_INFO: "player_info",



  SESSION_STOPPED: "session_stopped",
  SESSION_START_FAILED: "session_start_failed",
  START_SESSION_REQUESTED: "start_session_requested",
  START_SESSION_REQUESTED_REVERT: "start_session_requested_revert",
  STOP_SESSION_REQUESTED: "stop_session_requested",
  USER_EXIT_REQUESTED: "user_exit_requested",
  UPDATE_HOST_CONNECTION: "update_host_connection",
  HOST_CONNECTION_UPDATED: "host_connection_updated",
  CONNECT_TO_SESSION: "connect_to_session",

  // Unreal Client/Server Events
  REGISTER_UNREAL_CLIENT: "register_unreal_client",
  UNREAL_REGISTERED: "unreal_registered",
  UNREAL_SOCKET_CONNECTION_ESTABLISHED: "unreal_socket_connection_established",
  UNREAL_HOST_REGISTERED: "unreal_host_registered",
  REGISTER_UNREAL_SERVER: "register_unreal_server",
  UNREAL_SERVER_REGISTERED: "unreal_server_registered",
  UNREAL_SERVER_SOCKET_CONNECTION_ESTABLISHED:
    "unreal_server_socket_connection_established",
  UNREAL_SERVER_SOCKET_REGISTERED: "unreal_server_socket_registered",
  REGISTER_UNREAL_DEDICATED_SERVER: "register_unreal_dedicated_server",
  UNREAL_CLIENT_REGISTERD_SUCCESSFULLY: "unreal_client_registered_successfully",
  UNREAL_DEDICATED_SERVER_REGISTERD_SUCCESSFULLY: "unreal_dedicated_server_registered_successfully",


  // Game Mode Events
  CHANGE_GAME_MODE: "change_game_mode",
  UNREAL_CHANGE_MAP: "unreal_change_map",

  GAME_MODE_CHANGING: "game_mode_changing",
  CHANGE_GAME_MODE_REQUESTED: "change_game_mode_requested",
  CHANGE_GAME_MODE_REQUESTED_REVERT: "change_game_mode_requested_revert",
  GAME_MODE_CHANGED: "game_mode_changed",
  GAME_MODE_CHANGE_FAILED: "game_mode_change_failed",

  // Cube Spawn Events
  SPAWN_CUBE: "spawn_cube",
  SPAWN_CUBE_REQUESTED: "spawn_cube_requested",
  SPAWN_CUBE_REQUESTED_REVERT: "spawn_cube_requested_revert",
  CUBE_SPAWNED: "cube_spawned",
  CUBE_SPAWN_FAILED: "cube_spawn_failed",

  UPDATE_FE_LISTENPORT: "update_fe_listenport",
  FE_LISTENPORT_UPDATED: "fe_listenport_updated",
  CLOSE_CONNECTION: "close_connection",
  UNREAL_ROLE_CHANGED: "unreal_change_role",
  UNREAL_SOCKET_RECONNECTION: "unreal_client_reconnection",
  REJOIN_ROOM: "rejoin_room",
  YOU_ARE_NEW_HOST: "you_are_new_host",
  DISCONNECT_UNREAL_CLIENT: "disconnect_unreal_client",
  RESET_DEDICATED_SERVER: "reset_dedicated_server",
  CANCEL_JOIN_REQUEST: "H",
  JOIN_REQUEST_CANCELLED: "join_request_cancelled",
  REGISTER_UNREAL_MULTIPOV_INSTANCE: "register_unreal_multipov_instance",
  UNREAL_MULTIPOV_INSTANCE_REGISTERED: "unreal_multipov_instance_registered",

  CREATE_PLAYER: "create_player",
  CREATE_PLAYER_REVERT: "create_player_revert",
  CREATE_PLAYER_SUCCESS: "create_player_success",
  CREATE_PLAYER_FAILED: "create_player_failed",
  DELETE_PLAYER: "delete_player",

};

module.exports = { SocketEvents };
