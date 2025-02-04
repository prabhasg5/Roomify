import cv2
import numpy as np

def add_furniture(background_img_path, output_img_path, furniture_items):
    # Load the background image
    background = cv2.imread(background_img_path)
    
    # Load and prepare furniture images
    items = {item_name: cv2.imread(item_path, cv2.IMREAD_UNCHANGED) for item_name, item_path in furniture_items.items()}
    
    for item_name, item in items.items():
        # Resize the furniture item if needed
        item = cv2.resize(item, (100, 100))  # Example size
        
        # Convert to RGBA if not already
        if item.shape[2] == 3:
            item = cv2.cvtColor(item, cv2.COLOR_BGR2BGRA)
        
        # Define the position where you want to place the item
        x, y = 50, 50  # Example position

        # Ensure the furniture item fits within the background dimensions
        if (y + item.shape[0] > background.shape[0]) or (x + item.shape[1] > background.shape[1]):
            print(f"Item {item_name} is out of bounds and will not be added.")
            continue
        
        # Overlay the item on the background
        for c in range(0, 3):
            background[y:y+item.shape[0], x:x+item.shape[1], c] = (
                item[:, :, c] * (item[:, :, 3] / 255.0) + 
                background[y:y+item.shape[0], x:x+item.shape[1], c] * (1.0 - item[:, :, 3] / 255.0)
            )

    # Save the result
    cv2.imwrite(output_img_path, background)

# Example furniture items dictionary
furniture_items = {
    'sofa': 'sofa.webp',
    'curtains': 'curtains.webp',
    'tv': 'tv.webp',
    'carpet': 'carpet.jpeg'
}

# Add furniture to the room
add_furniture('empty_room.jpg', 'decorated_room.jpg', furniture_items)
