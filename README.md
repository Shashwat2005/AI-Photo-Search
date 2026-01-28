venv\Scripts\activate
uvicorn api_server:app --host 127.0.0.1 --port 8000

cd ai-photo-ui
npm run tauri dev
