-- In-game artwork chooser (data half + text menu).
--
-- What this does today, honestly: it reads the artwork index the host built, shows
-- the options in a dialog, applies the selected thumbnail and name to the project's
-- META through payloads/ns2jb-metadata.lua, and reports the result. What it does
-- NOT do yet is *draw a grid of previews*: the engine's drawing and input API is not
-- known (only `dialog` and `jump` tags are proven), so the selection comes from a
-- small file the editor can write - `save:/art/choice.txt` - with the file name on
-- line 1 and the project name on line 2. A real grid becomes possible once the
-- drawing/input calls are known; the data and write path below do not change.
--
--   save:/art/index.txt   one line per artwork: <file>\t<title>\t<description>
--   save:/art/choice.txt  optional: artwork file name, then optional project name
--   save:/f/###/META      the project metadata this applies to
local engine = ...

local ART = 'save:/art'
local META = 'save:/f/###/META'

local function readAll(path)
  local file = io.open(path, 'rb')
  if not file then return nil end
  local data
  pcall(function() data = file:read('*a') end)
  pcall(function() file:close() end)
  return data
end

local function dialog(title, message)
  if type(engine) ~= 'table' and type(engine) ~= 'userdata' then return end
  pcall(function() engine:tag{'dialog', title = tostring(title), message = tostring(message)} end)
end

local function parseIndex(text)
  local entries = {}
  if type(text) ~= 'string' then return entries end
  for line in text:gmatch('[^\r\n]+') do
    local file, title, description = line:match('^([^\t]*)\t?([^\t]*)\t?(.*)$')
    if file and file ~= '' then
      entries[#entries + 1] = {file = file, title = title ~= '' and title or file,
        description = description or ''}
    end
  end
  return entries
end

-- The selection: line 1 is the artwork file, line 2 the project name. With no choice
-- file the first artwork is applied, so a first run always shows a result.
local function choose(entries, choiceText)
  local file, name
  if type(choiceText) == 'string' then
    local lines = {}
    for line in choiceText:gmatch('[^\r\n]+') do lines[#lines + 1] = line end
    file, name = lines[1], lines[2]
  end
  if file and file ~= '' then
    for _, entry in ipairs(entries) do
      if entry.file == file or entry.title == file then return entry, name end
    end
    return nil, name, 'no artwork named ' .. file
  end
  return entries[1], name
end

local metadata
do
  local source = readAll('save:/ns2jb-metadata.lua')
  if source then
    local chunk = loadstring(source, '@ns2jb-metadata.lua')
    if chunk then
      local ok, module = pcall(chunk)
      if ok then metadata = module end
    end
  end
end

local entries = parseIndex(readAll(ART .. '/index.txt'))
if #entries == 0 then
  dialog('ns2jb artwork', 'no artwork found\nput .raw files and index.txt in\n' .. ART)
  return
end

local entry, wanted, problem = choose(entries, readAll(ART .. '/choice.txt'))
if not entry then
  dialog('ns2jb artwork', 'invalid choice\n' .. tostring(problem))
  return
end
if not metadata then
  dialog('ns2jb artwork', 'ns2jb-metadata.lua missing\ncannot write ' .. META)
  return
end

local list = {}
for i, item in ipairs(entries) do
  list[#list + 1] = tostring(i) .. '. ' .. item.title .. ' (' .. item.file .. ')'
end
local name = wanted
if type(name) ~= 'string' or name == '' then name = entry.title end

local ok, why = metadata.apply(META, name, ART .. '/' .. entry.file, false)
if not ok then
  dialog('ns2jb artwork', 'could not apply ' .. entry.file .. '\n' .. tostring(why))
  return
end

dialog('ns2jb artwork', 'applied ' .. entry.title .. ' as "' .. name .. '"\n\n' ..
  'available:\n' .. table.concat(list, '\n'))
