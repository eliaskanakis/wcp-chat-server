#gcloud auth login 

gcloud config set project wrh-coord-platform  

gcloud run deploy ws-server `
  --source . `
  --platform managed `
  --region europe-west1 `
  --allow-unauthenticated `
  --env-vars-file .env-yaml
