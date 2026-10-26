import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const directory = fs.readFileSync(new URL('../dist/latest-component.txt',import.meta.url),'utf8').trim();
const manifest = JSON.parse(fs.readFileSync(path.join(directory,'component.json'),'utf8'));
const target = path.resolve(directory,'..',`wdh-${manifest.version}-${manifest.platform}-${manifest.arch}.zip`);
const python = process.env.WDH_BUILD_PYTHON || (process.platform==='win32'?'python':'python3');
const script = `import json,pathlib,sys,zipfile,hashlib
root=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); manifest=json.loads((root/'component.json').read_text())
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as bundle:
 for name in ['component.json']+[entry['path'] for entry in manifest['files']]:
  file=root/name
  if file.is_symlink() or not file.resolve().is_relative_to(root.resolve()): raise RuntimeError('Unsafe component path')
  bundle.write(file,name)
digest=hashlib.sha256(target.read_bytes()).hexdigest();target.with_suffix('.zip.sha256').write_text(digest+'  '+target.name+'\\n')
print(str(target));print(digest)
`;
execFileSync(python,['-c',script,directory,target],{stdio:'inherit'});
