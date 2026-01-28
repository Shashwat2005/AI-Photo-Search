import json
import torch
import open_clip
import faiss

INDEX_DIR = "index"


def load_model():
    model, _, _ = open_clip.create_model_and_transforms(
        "ViT-B-32", pretrained="laion2b_s34b_b79k"
    )
    model.eval()
    tokenizer = open_clip.get_tokenizer("ViT-B-32")
    return model, tokenizer


def load_index():
    index = faiss.read_index(f"{INDEX_DIR}/image_index.faiss")
    with open(f"{INDEX_DIR}/metadata.json", "r") as f:
        paths = json.load(f)
    return index, paths


def encode_text(model, tokenizer, text):
    with torch.no_grad():
        tokens = tokenizer([text])
        emb = model.encode_text(tokens)
        emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb.cpu().numpy()


def main():
    model, tokenizer = load_model()
    index, paths = load_index()

    query = "Tall Buildings"
    q_emb = encode_text(model, tokenizer, query)

    k = 5  # top results
    scores, ids = index.search(q_emb, k)

    print(f"\nQuery: {query}")
    print("Results:")
    for score, idx in zip(scores[0], ids[0]):
        print(f"{paths[idx]}  |  score={score:.4f}")


if __name__ == "__main__":
    main()