# Dikte

Windows için yerel (internetsiz) dikte uygulaması. Ekranın altında ince bir bar; kayıt tuşuna basınca söylediklerini
Whisper ile canlı yazıya çevirir. Türkçe + İngilizce. Ses ve metin diske yazılmaz.

## Geliştirme
    npm install
    npm start            # .venv içindeki Python + HuggingFace önbelleğindeki modeli kullanır

## Exe üretme (model dahil, ~3.7 GB klasör)
    npm run pack         # dist/Dikte-win32-x64/Dikte.exe

`scripts/stage.py` taşınabilir Python'u, faster-whisper/CUDA kütüphanelerini ve `medium` modelini `build/` altına hazırlar;
`electron-packager` bunları uygulamanın `resources` klasörüne koyar. Gerekenler: Python 3.12, `.venv` (faster-whisper kurulu), indirilmiş medium modeli.

## Kelime listesi
`vocabulary.txt` dosyasına eklediğin kelimeler, modelin benzer yanlış yazımlarını düzeltmek için kullanılır.

## Gizlilik
Ses ve metin varsayılan olarak diske yazılmaz. Sadece geliştirme için `DIKTE_KEEP_RECORDINGS=1` ile açılır ve uygulama kapanınca silinir.
