-- Offline tests for payloads/ns2jb-artwork.lua.
--
--   lua tests/test_artwork_lua.lua
--
-- The engine and filesystem are stubs, so this proves the selection logic, the
-- index parsing and the report wording - not that the console draws anything. The
-- artwork blobs come from tools/artwork-build.cjs --generate when that has been run
-- into /tmp/art; otherwise the suite builds one in memory.
local here = arg[0]:match('^(.*)/[^/]*$') or '.'
local root = here .. '/..'

local function slurp(path)
  local f = io.open(path, 'rb')
  if not f then return nil end
  local d = f:read('*a')
  f:close()
  return d
end

local artworkSource = assert(slurp(root .. '/payloads/ns2jb-artwork.lua'), 'artwork payload')
local metadataSource = assert(slurp(root .. '/payloads/ns2jb-metadata.lua'), 'metadata library')
local M = assert(load(metadataSource, '@ns2jb-metadata.lua'))()

local passed, failed = 0, 0
local function check(name, ok, detail)
  if ok then passed = passed + 1; print('ok    ' .. name)
  else failed = failed + 1; print('FAIL  ' .. name .. (detail and ('\n      ' .. tostring(detail)) or '')) end
end

local function baseMeta()
  local header = string.rep('\0', M.header)
  local icon = string.rep('\1', M.width * M.height * 4)
  local blob = header .. icon
  blob = blob:sub(1, M.header) .. M.tag ..
    '[\0W\0O\0R\0K\0S\0P\0A\0C\0E\0]\0\0\0' .. blob:sub(M.header + 33)
  return blob
end

local function engineStub(dialogs)
  local engine = {}
  function engine.tag(self, tag)
    if type(tag) == 'table' and tag[1] == 'dialog' then
      dialogs[#dialogs + 1] = {title = tag.title, message = tag.message}
    end
  end
  return engine
end

-- Run the payload against a table-backed filesystem. `writes` collects results and
-- `dialogs` collects what the payload would show; the engine stub is built here so
-- both come from the same run.
local function run(files)
  local dialogs, writes = {}, {}
  local engine = engineStub(dialogs)
  local fakeIo = {}
  function fakeIo.open(path, mode)
    if mode and mode:find('w') then
      local buffer = {}
      return {
        write = function(_, text) buffer[#buffer + 1] = text end,
        flush = function() end,
        close = function() writes[path] = table.concat(buffer) end
      }
    end
    local content = files[path]
    if content == nil then return nil end
    local position = 1
    return {
      read = function(_, what)
        if what == '*a' then local out = content:sub(position); position = #content + 1; return out end
        return nil
      end,
      close = function() end
    }
  end
  local env = {
    io = fakeIo, pcall = pcall, tostring = tostring, string = string, table = table,
    math = math, type = type, ipairs = ipairs, _VERSION = 'Lua 5.1'
  }
  -- Nested loads (the metadata library the payload loads from the save) must inherit
  -- the stub environment too, or they would use the real io and touch the host.
  env.loadstring = function(src, name) return load(src, name or '=(loadstring)', 't', env) end
  local chunk = assert(load(artworkSource, '@ns2jb-artwork.lua', 't', env))
  chunk(engine)
  return dialogs, writes
end

local icon = string.rep('\2', M.width * M.height * 4)
local files = {
  ['save:/art/index.txt'] = 'a.raw\tAAA\tfirst\nb.raw\tBBB\tsecond\n',
  ['save:/art/a.raw'] = icon,
  ['save:/art/b.raw'] = icon,
  ['save:/f/###/META'] = baseMeta(),
  ['save:/ns2jb-metadata.lua'] = metadataSource
}

check('no index -> dialog says where artwork goes', (function()
  local dialogs, writes = run({})
  return writes['save:/f/###/META'] == nil and dialogs[1] ~= nil and
    tostring(dialogs[1].message):find('no artwork found') ~= nil
end)())

check('no choice file -> first artwork becomes the name', (function()
  local d = {}
  local dialogs, writes = run(files)
  local meta = writes['save:/f/###/META']
  return meta ~= nil and M.nameAt(meta) == 'AAA'
end)())

check('choice.txt selects by file name and sets the project name', (function()
  local f = {}
  for k, v in pairs(files) do f[k] = v end
  f['save:/art/choice.txt'] = 'b.raw\nHOMEBREW\n'
  local d = {}
  local dialogs, writes = run(f)
  local meta = writes['save:/f/###/META']
  return meta ~= nil and M.nameAt(meta) == 'HOMEBREW'
end)())

check('choice.txt can select by title', (function()
  local f = {}
  for k, v in pairs(files) do f[k] = v end
  f['save:/art/choice.txt'] = 'BBB\n'
  local dialogs, writes = run(f)
  local meta = writes['save:/f/###/META']
  return meta ~= nil and M.nameAt(meta) == 'BBB'
end)())

check('unknown artwork is refused with a dialog', (function()
  local f = {}
  for k, v in pairs(files) do f[k] = v end
  f['save:/art/choice.txt'] = 'nope.raw\n'
  local dialogs, writes = run(f)
  return writes['save:/f/###/META'] == nil and dialogs[1] ~= nil and
    tostring(dialogs[1].message):find('invalid choice') ~= nil
end)())

check('a missing metadata library is reported, not ignored', (function()
  local f = {}
  for k, v in pairs(files) do f[k] = v end
  f['save:/ns2jb-metadata.lua'] = nil
  local dialogs, writes = run(f)
  return writes['save:/f/###/META'] == nil and dialogs[1] ~= nil and
    tostring(dialogs[1].message):find('metadata') ~= nil
end)())

check('the success dialog lists the available artwork', (function()
  local d = {}
  local dialogs = run(files)
  local message = dialogs[1] and tostring(dialogs[1].message) or ''
  return message:find('applied') ~= nil and message:find('AAA') ~= nil and
    message:find('BBB') ~= nil
end)())

check('the applied META keeps its size', (function()
  local dialogs, writes = run(files, engineStub({}))
  local meta = writes['save:/f/###/META']
  return meta ~= nil and #meta == M.size
end)())

print(string.format('\n%d passed, %d failed', passed, failed))
os.exit(failed == 0 and 0 or 1)
