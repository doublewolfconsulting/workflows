import os
import google.auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

creds, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/drive'])
service = build('drive', 'v3', credentials=creds)

file_id = os.environ['GOOGLE_DOC_ID']
media = MediaFileUpload(
    'output.docx',
    mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
)
service.files().update(fileId=file_id, media_body=media).execute()
print(f'Synced to Google Doc: {file_id}')
