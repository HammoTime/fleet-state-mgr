# Proposed Changes

Unfortunately the current MCP API is just too complex for use.

We now want the following:
`new_session(name: string) { returns id: string }`
`get_session() { returns id: string, name: string }`
`clean_sessions()`
`get(id: string) { returns content: string }`
`put(agent_name: string, file_name: string, content: string, overwrite=false: boolean) { returns id: string }`

## ID Formats

### Run

`fsm::run::${RUN_ID}`

### File

`fsm::file::${SESSION_ID}::${AGENT_NAME}::${FILE_NAME}`

## Method Implementations

### `new_session()`

This runs the following commands
```
mkdir -p ${FLEET_STATE_DIRECTORY}

if exists("${FLEET_STATE_DIRECTORY}/current_run_id.txt") then
  echo "${FLEET_STATE_DIRECTORY}/current_run_id.txt" >> previous_run_log.txt

echo "${RANDOM_UUID}:::${SESSION_NAME}" > ${FLEET_STATE_DIRECTORY}/current_run.txt
```

### `clean_sessions()`

This runs the following commands
```
rm -r ${FLEET_STATE_DIRECTORY}
mkdir -p ${FLEET_STATE_DIRECTORY}
```

### `get_session()`

```
if exists("${FLEET_STATE_DIRECTORY}/current_run_id.txt") then
  return cat("${FLEET_STATE_DIRECTORY}/current_run_id.txt").split(":::")

return ERR_NO_ACTIVE_SESSION
```

### `get()`

```
_, id_type, session_id, agent_name, file_name = id.split("::")
session_dir = "${FLEET_STATE_DIRECTORY}/${session_id}"
agent_dir = "${session_dir}/${agent_name}"
file_path = "${agent_dir}/${file_name}"

if id_components[1] != "file" then
  return ERR_CAN_ONLY_RETRIEVE_FILES

if not exists("${session_dir}") then
  return ERR_SESSION_NOT_VALID

if not exists("${agent_dir}") then
  return ERR_AGENT_NOT_VALID

if not exists("${file_path}") then
  return ERR_FILE_NOT_FOUND

return cat("${file_path}")
```

### `put()`

```
session_id = get_session().id

if session_id = ERR_NO_ACTIVE_SESSION then
  return ERR_NO_ACTIVE_SESSION

target_dir = "${FLEET_STATE_DIRECTORY}/${session_id}/${agent_name}"
file_path = "${target_dir}/${file_name}"

mkdir -p ${target_dir}

if exists("${file_path}) and not overwrite then
  return ERR_FILE_EXISTS

echo "${content}" > "${file_path}"

return "fsm::file::${session_id}::${agent_name}::${file_path}"
```
