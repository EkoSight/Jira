# Face detection model

`blaze_face_short_range.tflite`: MediaPipe Face Detector, short range (float16, version 1),
from Google's MediaPipe models (Apache License 2.0):
https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite

It is served from TaskFlow itself so the photo editor never sends anything to another site.
The engine (`@mediapipe/tasks-vision` WebAssembly files) is copied from node_modules at build
time into `dist/vendor/mediapipe/<version>/`, with gzip copies the server sends to browsers
that accept them. Only face *detection* (where a face is) is used; nothing recognises who it is.
