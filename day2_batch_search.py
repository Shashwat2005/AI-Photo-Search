import torch
import open_clip
from PIL import Image
import os
from typing import List

VALID_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
IMAGE_FOLDER = "images"
BATCH_SIZE = 8  # you can tune this later


# --------- MODEL LOADING ---------
def load_model():
    model, preprocess, _ = open_clip.create_model_and_transforms(
        "ViT-B-32",
        pretrained="laion2b_s34b_b79k"
    )
    model.eval()
    tokenizer = open_clip.get_tokenizer("ViT-B-32")
    return model, preprocess, tokenizer


# --------- IMAGE LOADING ---------
def load_images(folder: str):
    images = []
    names = []

    for name in os.listdir(folder):
        if not name.lower().endswith(VALID_EXTENSIONS):
            continue

        path = os.path.join(folder, name)
        try:
            img = Image.open(path).convert("RGB")
            images.append(img)
            names.append(name)
        except Exception as e:
            print(f"Skipping {name}: {e}")

    return images, names


# --------- BATCH ENCODING ---------
def encode_images(model, preprocess, images: List[Image.Image]):
    embeddings = []

    with torch.no_grad():
        for i in range(0, len(images), BATCH_SIZE):
            batch = images[i:i + BATCH_SIZE]
            batch_tensor = torch.stack([preprocess(img) for img in batch])
            batch_emb = model.encode_image(batch_tensor)
            batch_emb = batch_emb / batch_emb.norm(dim=-1, keepdim=True)  # normalize
            embeddings.append(batch_emb)

    return torch.cat(embeddings)


# --------- TEXT ENCODING ---------
def encode_text(model, tokenizer, text: str):
    with torch.no_grad():
        tokens = tokenizer([text])
        emb = model.encode_text(tokens)
        emb = emb / emb.norm(dim=-1, keepdim=True)  # normalize
    return emb


# --------- SEARCH ---------
def search(image_embeddings, image_names, text_embedding):
    scores = (image_embeddings @ text_embedding.T).squeeze()
    results = sorted(zip(scores, image_names), reverse=True)
    return results


# --------- MAIN ---------
def main():
    print("Loading model...")
    model, preprocess, tokenizer = load_model()

    print("Loading images...")
    images, names = load_images(IMAGE_FOLDER)

    if not images:
        raise RuntimeError("No valid images found.")

    print(f"Encoding {len(images)} images...")
    image_embeddings = encode_images(model, preprocess, images)

    query = "a park"
    print(f"Searching for: '{query}'")
    text_embedding = encode_text(model, tokenizer, query)

    results = search(image_embeddings, names, text_embedding)

    print("\nSearch Results:")
    for score, name in results:
        print(f"{name}: {score.item():.4f}")


if __name__ == "__main__":
    main()
