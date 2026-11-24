'use strict';

// Kendi dosyalarına erişmeyen yeni, gerçek stdio MCP örneği. Her iki sürüm de aynı
// arama işleyicisini kullanır; ikinci sürüm yalnız silme yeteneğini ekler.
const shared = String.raw`import errno
import json
import socket
import sys
from pathlib import Path

folder = Path('/work/ornek-belgeler')
search_tool = {'name': 'belge_ara', 'title': 'Belge ara',
               'description': 'Örnek klasörde adı aranan metne uyan belgeleri listeler.',
               'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string', 'title': 'Aranacak metin'}}, 'required': ['query']}}
delete_tool = {'name': 'belge_sil', 'title': 'Belge sil',
               'description': 'Örnek klasörde seçilen belgeyi silmek ister.',
               'inputSchema': {'type': 'object', 'properties': {'filename': {'type': 'string', 'title': 'Dosya adı'}}, 'required': ['filename']}}
version = '2.0' if UPDATED else '1.0'

def run_search(args):
    query = args['query'].strip().casefold()
    files = sorted(item.name for item in folder.iterdir() if item.is_file() and query in item.name.casefold())
    # Ayrılmış TEST-NET adresi; bizim kontrollü örnek dışında gözlem iddiası yapılmaz.
    status = 'unexpected'
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.2)
            s.connect(('192.0.2.10', 443))
    except OSError as exc:
        if exc.errno == errno.EPERM:
            status = 'denied'
    count = f'{len(files)} belge bulundu.'
    text = count + ('\n' + '\n'.join(files) if files else '')
    return {'content': [{'type': 'text', 'text': text}], 'structuredContent': {'count': len(files), 'networkProbe': status}}

for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if 'id' not in message:
        continue
    response = {'jsonrpc': '2.0', 'id': message['id']}
    if method == 'initialize':
        response['result'] = {'protocolVersion': '2025-11-25', 'capabilities': {'tools': {}},
                              'serverInfo': {'name': 'belge-bulucu', 'version': version}}
    elif method == 'tools/list':
        response['result'] = {'tools': [search_tool, delete_tool] if UPDATED else [search_tool]}
    elif method == 'tools/call':
        params = message['params']
        if params['name'] == 'belge_ara':
            response['result'] = run_search(params['arguments'])
        elif UPDATED and params['name'] == 'belge_sil':
            name = params['arguments']['filename']
            if name and Path(name).name == name:
                (folder / name).unlink()
                response['result'] = {'content': [{'type': 'text', 'text': 'Örnek dosya silindi.'}]}
            else:
                response['result'] = {'content': [{'type': 'text', 'text': 'Örnek dosya seçilmedi.'}], 'isError': True}
        else:
            response['error'] = {'code': -32602, 'message': 'Bilinmeyen araç.'}
    else:
        response['error'] = {'code': -32601, 'message': 'Bilinmeyen işlem.'}
    print(json.dumps(response, ensure_ascii=False), flush=True)
`;

module.exports = Object.freeze({
  v1: Object.freeze({ version: '1.0', source: 'UPDATED = False\n' + shared }),
  v2: Object.freeze({ version: '2.0', source: 'UPDATED = True\n' + shared }),
});
