"""Paketleme için çalışma klasörünü (build/) hazırlar:
  build/py      -> taşınabilir Python (+ faster-whisper ve CUDA kütüphaneleri)
  build/models  -> Whisper 'medium' modeli (internetsiz çalışır)
  build/python  -> whisper_server.py
Sonra 'npm run pack' bunları uygulamanın resources klasörüne koyar."""
import os, shutil, sys, glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BUILD = os.path.join(ROOT, 'build')
MODEL = os.environ.get('DIKTE_MODEL', 'medium')
SKIP_NVRTC = os.environ.get('DIKTE_SKIP_NVRTC', '1') == '1'   # 179 MB; gerekmezse paketten çıkar

def ignore_py(dirpath, names):
    rel = os.path.relpath(dirpath, sys.base_prefix).replace(os.sep, '/')
    skip = set(n for n in names if n in ('__pycache__',))
    if rel == '.':
        skip |= {n for n in names if n in ('Doc', 'Tools', 'include', 'libs', 'Scripts', 'tcl', 'NEWS.txt')}
    if rel == 'Lib':
        skip |= {n for n in names if n in ('site-packages', 'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'lib2to3')}
    return skip

def ignore_sp(dirpath, names):
    skip = {n for n in names if n == '__pycache__' or n.startswith(('pip', 'setuptools', 'pkg_resources', '_distutils_hack', 'wheel'))}
    if SKIP_NVRTC and os.path.basename(dirpath) == 'nvidia':
        skip |= {n for n in names if n == 'cuda_nvrtc'}
    return skip

def main():
    if os.path.isdir(BUILD):
        shutil.rmtree(BUILD)
    print('1/4 Python çalışma ortamı kopyalanıyor...')
    shutil.copytree(sys.base_prefix, os.path.join(BUILD, 'py'), ignore=ignore_py)
    print('2/4 Kütüphaneler (faster-whisper, CUDA) kopyalanıyor...')
    sp_src = os.path.join(ROOT, '.venv', 'Lib', 'site-packages')
    shutil.copytree(sp_src, os.path.join(BUILD, 'py', 'Lib', 'site-packages'), ignore=ignore_sp)
    print(f'3/4 Model ({MODEL}) kopyalanıyor...')
    snap = glob.glob(os.path.join(os.path.expanduser('~'), '.cache', 'huggingface', 'hub', f'models--Systran--faster-whisper-{MODEL}', 'snapshots', '*'))[0]
    shutil.copytree(snap, os.path.join(BUILD, 'models', MODEL))
    print('4/4 Sunucu betiği...')
    os.makedirs(os.path.join(BUILD, 'python'))
    shutil.copy(os.path.join(ROOT, 'python', 'whisper_server.py'), os.path.join(BUILD, 'python'))
    total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(BUILD) for f in fs)
    print(f'Hazır: {total/1e9:.2f} GB  ->  {BUILD}')

if __name__ == '__main__':
    main()
