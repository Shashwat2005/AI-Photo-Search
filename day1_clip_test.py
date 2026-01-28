import torch
import open_clip
from PIL import Image
import os

VALID_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")

# Load model
model, preprocess, _ = open_clip.create_model_and_transforms(
    "ViT-B-32",
    pretrained="laion2b_s34b_b79k"
)
model.eval()

# IMPORTANT: get tokenizer properly
tokenizer = open_clip.get_tokenizer("ViT-B-32")

image_folder = "images"
image_embeddings = []
image_names = []

for img_name in os.listdir(image_folder):
    if not img_name.lower().endswith(VALID_EXTENSIONS):
        continue

    img_path = os.path.join(image_folder, img_name)

    try:
        image = Image.open(img_path).convert("RGB")
        image = preprocess(image).unsqueeze(0)

        with torch.no_grad():
            embedding = model.encode_image(image)

        image_embeddings.append(embedding)
        image_names.append(img_name)

    except Exception as e:
        print(f"Skipping {img_name}: {e}")

if not image_embeddings:
    raise RuntimeError("No valid images found.")

image_embeddings = torch.cat(image_embeddings)

# ---- TEXT QUERY ----
query = "a dog playing"
text_tokens = tokenizer([query])

with torch.no_grad():
    text_embedding = model.encode_text(text_tokens)

# ---- SIMILARITY ----
similarity = (image_embeddings @ text_embedding.T).squeeze()

results = sorted(zip(similarity, image_names), reverse=True)

print("\nSearch Results:")
for score, name in results:
    print(f"{name}: {score.item():.4f}")
