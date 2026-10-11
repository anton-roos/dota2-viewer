"""Local file server for the Dota 2 model viewer.

Serves raw files out of several Dota 2 builds (VPK archives first, loose files second)
so the browser viewer can parse models and textures itself. Standard library only.

    python -I server.py            -> http://127.0.0.1:5180
"""
import json
import os
import struct
import sys
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 5180

# Each build is a "dota" game folder: pak01_dir.vpk plus loose files, plus an optional platform folder.
BUILDS = {
    'jan2011': {
        'label': 'January 2011 (depot 571 v0, PatchVersion 37)',
        'game': r'D:\steam2browser\steam2info\extracted\571_0\dota',
        'platform': r'D:\steam2browser\steam2info\extracted\571_0\platform',
    },
    'jul2011': {
        'label': 'July 2011 (depot 681 v0, PatchVersion 38)',
        'game': r'D:\Games\681_0\dota',
        'platform': r'D:\Games\681_0\platform',
    },
    'dota684': {
        'label': '6.84c (Sept 2015, last Source 1)',
        'game': r'D:\Games\Dota 2\dota',
        'platform': r'D:\Games\Dota 2\platform',
    },
}


class VPK:
    """Reads a VPK v1/v2 directory and the files inside its numbered archives."""

    def __init__(self, dir_path):
        self.dir_path = dir_path
        self.base = dir_path[:-len('_dir.vpk')]
        with open(dir_path, 'rb') as f:
            d = f.read()
        sig, ver, tree = struct.unpack_from('<III', d, 0)
        if sig != 0x55AA1234:
            raise ValueError(f'{dir_path} is not a VPK')
        hdr = 12 if ver == 1 else 28
        self.data_start = hdr + tree
        self.d = d
        self.files = {}
        o = hdr

        def cstr():
            nonlocal o
            e = d.index(b'\0', o)
            s = d[o:e].decode('latin1')
            o = e + 1
            return s

        while True:
            ext = cstr()
            if not ext:
                break
            while True:
                path = cstr()
                if not path:
                    break
                while True:
                    name = cstr()
                    if not name:
                        break
                    _crc, pre, arc, off, ln, _term = struct.unpack_from('<IHHIIH', d, o)
                    o += 18
                    full = f'{path}/{name}.{ext}' if path.strip() else f'{name}.{ext}'
                    self.files[full.lower()] = (arc, off, ln, o, pre)
                    o += pre

    def read(self, path):
        arc, off, ln, preoff, pre = self.files[path]
        data = self.d[preoff:preoff + pre]
        if ln:
            if arc == 0x7FFF:
                fn, off = self.dir_path, self.data_start + off
            else:
                fn = f'{self.base}_{arc:03d}.vpk'
            with open(fn, 'rb') as f:
                f.seek(off)
                data += f.read(ln)
        return data


class Build:
    def __init__(self, key, cfg):
        self.key = key
        self.label = cfg['label']
        self.roots = [r for r in (cfg['game'], cfg.get('platform')) if r and os.path.isdir(r)]
        self.vpks = []
        for root in self.roots:
            p = os.path.join(root, 'pak01_dir.vpk')
            if os.path.exists(p):
                self.vpks.append(VPK(p))
        self.available = bool(self.roots)

    def read(self, path):
        path = path.replace('\\', '/').lower()
        while '//' in path:  # the engine filesystem tolerates doubled slashes in asset paths
            path = path.replace('//', '/')
        path = path.lstrip('/')
        for root in self.roots:  # loose files override VPK contents, as in the engine
            p = os.path.join(root, *path.split('/'))
            if os.path.isfile(p):
                with open(p, 'rb') as f:
                    return f.read()
        for v in self.vpks:
            if path in v.files:
                return v.read(path)
        return None

    def list(self, ext):
        out = set()
        for v in self.vpks:
            out.update(p for p in v.files if p.endswith(ext))
        for root in self.roots:
            for dp, _, fs in os.walk(os.path.join(root, 'models')):
                for f in fs:
                    if f.lower().endswith(ext):
                        out.add(os.path.relpath(os.path.join(dp, f), root).replace('\\', '/').lower())
        return sorted(out)


    def list_prefix(self, prefix, ext):
        """Paths under prefix with extension, from VPKs and loose files."""
        out = set(p for v in self.vpks for p in v.files if p.startswith(prefix) and p.endswith(ext))
        for root in self.roots:
            base = os.path.join(root, *prefix.rstrip('/').split('/'))
            for dp, _, fs in os.walk(base):
                for f in fs:
                    if f.lower().endswith(ext):
                        out.add(os.path.relpath(os.path.join(dp, f), root).replace('\\', '/').lower())
        return sorted(out)

    def text(self, path):
        data = self.read(path)
        if data is None:
            return None
        if data[:2] in (b'\xff\xfe', b'\xfe\xff'):
            return data.decode('utf-16')
        return data.decode('utf-8', 'replace')

    def sounds(self):
        """Every soundscript entry in the build: name -> waves, volume, pitch, soundlevel."""
        if hasattr(self, '_sounds'):
            return self._sounds
        out = {}
        for path in self.list_prefix('scripts/', '.txt'):
            if 'game_sounds' not in path.rsplit('/', 1)[-1]:
                continue
            for name, body in kv_pairs(self.text(path) or ''):
                if not isinstance(body, list):
                    continue
                entry = {'file': path, 'waves': []}
                for k, v in walk_pairs(body):
                    k = k.lower()
                    if k == 'wave':
                        entry['waves'].append(v)
                    elif k in ('volume', 'pitch', 'soundlevel', 'channel') and k not in entry:
                        entry[k] = v
                if entry['waves']:
                    out[name.lower()] = entry
        self._sounds = out
        return out

    def units(self):
        """Model path -> unit name and SoundSet, from npc_heroes.txt and npc_units.txt."""
        if hasattr(self, '_units'):
            return self._units
        out = {}
        for path in ('scripts/npc/npc_heroes.txt', 'scripts/npc/npc_units.txt'):
            for _root, body in kv_pairs(self.text(path) or ''):
                if not isinstance(body, list):
                    continue
                for unit, fields in body:
                    if not isinstance(fields, list):
                        continue
                    d = {k.lower(): v for k, v in fields if isinstance(v, str)}
                    model = d.get('model', '').replace('\\', '/').lower()
                    if model and model not in out:
                        out[model] = {'unit': unit, 'soundSet': d.get('soundset', ''),
                                      'gameSoundsFile': d.get('gamesoundsfile', '')}
        self._units = out
        return out


    def wearables(self):
        """Hero unit -> wearable items from items_game.txt (prefabs resolved), defaults first."""
        if hasattr(self, '_wearables'):
            return self._wearables
        out = {}
        text = self.text('scripts/items/items_game.txt')
        if text:
            top = next((v for k, v in kv_pairs(text) if isinstance(v, list)), [])
            section = lambda name: next((v for k, v in top if k == name and isinstance(v, list)), [])

            def flat(fields):
                d = {k.lower(): v for k, v in fields if isinstance(v, str)}
                heroes = next((v for k, v in fields if k.lower() == 'used_by_heroes' and isinstance(v, list)), None)
                if heroes is not None:
                    d['_heroes'] = [h for h, on in heroes if on != '0']
                return d

            prefabs = {k: flat(v) for k, v in section('prefabs') if isinstance(v, list)}
            for iid, fields in section('items'):
                if not isinstance(fields, list):
                    continue
                d = flat(fields)
                merged = {}
                for p in d.get('prefab', '').split():  # prefabs can be space-separated
                    merged.update(prefabs.get(p, {}))
                merged.update(d)
                model = merged.get('model_player', '').replace('\\', '/').lower()
                if not model or merged.get('item_class', 'dota_item_wearable') != 'dota_item_wearable':
                    continue
                is_default = merged.get('baseitem') == '1' or 'default_item' in d.get('prefab', '')
                for hero in merged.get('_heroes', []):
                    out.setdefault(hero, []).append({
                        'id': iid, 'name': merged.get('name', iid), 'slot': merged.get('item_slot', 'weapon'),
                        'model': model, 'default': is_default, 'rarity': merged.get('item_rarity', ''),
                    })
        for items in out.values():
            items.sort(key=lambda i: (not i['default'], i['slot'], i['name']))
        self._wearables = out
        return out


def kv_tokens(text):
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
        elif c in '{}':
            yield c
            i += 1
        elif c == '"':
            j = text.find('"', i + 1)
            j = n if j < 0 else j
            yield ('s', text[i + 1:j])
            i = j + 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '{}"':
                j += 1
            yield ('s', text[i:j])
            i = j


def kv_pairs(text):
    """KeyValues as nested lists of (key, value) pairs, keeping duplicate keys (soundscripts repeat "wave")."""
    stack = [[]]
    key = None
    for t in kv_tokens(text):
        if t == '{':
            node = []
            stack[-1].append((key if key is not None else '', node))
            stack.append(node)
            key = None
        elif t == '}':
            if len(stack) > 1:
                stack.pop()
            key = None
        elif key is None:
            key = t[1]
        else:
            stack[-1].append((key, t[1]))
            key = None
    return stack[0]


def walk_pairs(pairs):
    for k, v in pairs:
        if isinstance(v, list):
            yield from walk_pairs(v)
        else:
            yield k, v


_builds = {}
_lock = threading.Lock()


def get_build(key):
    with _lock:
        if key not in _builds:
            _builds[key] = Build(key, BUILDS[key])
        return _builds[key]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype='application/octet-stream'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        # game files never change; the viewer's own html/js do while it is being worked on
        static = ctype.startswith('text/')
        self.send_header('Cache-Control', 'no-store' if static else 'max-age=3600')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == '/api/builds':
                body = [{'key': k, 'label': c['label'], 'available': os.path.isdir(c['game'])}
                        for k, c in BUILDS.items()]
                return self.send(200, json.dumps(body).encode(), 'application/json')
            if u.path == '/api/models':
                b = get_build(q['build'])
                return self.send(200, json.dumps(b.list('.mdl')).encode(), 'application/json')
            if u.path == '/api/sounds':
                return self.send(200, json.dumps(get_build(q['build']).sounds()).encode(), 'application/json')
            if u.path == '/api/units':
                return self.send(200, json.dumps(get_build(q['build']).units()).encode(), 'application/json')
            if u.path == '/api/wearables':
                b = get_build(q['build'])
                hero = q.get('hero')
                data = b.wearables().get(hero, []) if hero else b.wearables()
                return self.send(200, json.dumps(data).encode(), 'application/json')
            if u.path == '/api/file':
                b = get_build(q['build'])
                data = b.read(q['path'])
                if data is None:
                    return self.send(404, b'not found', 'text/plain')
                return self.send(200, data)
            static = {'/': 'index.html', '/index.html': 'index.html', '/source.js': 'source.js'}
            if u.path in static:
                fn = os.path.join(HERE, static[u.path])
                with open(fn, 'rb') as f:
                    data = f.read()
                ctype = 'text/html; charset=utf-8' if fn.endswith('.html') else 'text/javascript'
                return self.send(200, data, ctype)
            self.send(404, b'not found', 'text/plain')
        except KeyError as e:
            self.send(400, f'missing or unknown parameter {e}'.encode(), 'text/plain')
        except Exception as e:  # report instead of dropping the connection
            self.send(500, repr(e).encode(), 'text/plain')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Dota model viewer on http://127.0.0.1:{port}')
    srv.serve_forever()
