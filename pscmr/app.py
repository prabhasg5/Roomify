from flask import Flask, request, jsonify, send_file, render_template
from flask_cors import CORS
import sqlite3
import os
from io import BytesIO
import requests
import base64
import urllib.parse
import google.generativeai as genai
from PIL import Image
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)
CORS(app, origins=["http://127.0.0.1:5000", "http://localhost:5000"], 
     allow_headers=["Content-Type"],
     methods=["GET", "POST", "OPTIONS"]) 

# Database connection function
def get_db_connection():
    conn = sqlite3.connect('epics.db')
    conn.row_factory = sqlite3.Row
    return conn

# Configuration for image upload and generation
UPLOAD_FOLDER = os.path.join(app.root_path, 'uploads/images')
GENERATED_FOLDER = os.path.join(app.root_path, 'static/images/generated')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['GENERATED_FOLDER'] = GENERATED_FOLDER

# Ensure the directories exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(GENERATED_FOLDER, exist_ok=True)

# Load API keys from environment variables
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')
HF_API_TOKEN = os.getenv('HF_API_TOKEN', '')

# Configure Gemini
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)


@app.route('/items', methods=['GET'])
def get_items():
    room_type = request.args.get('room')
    cost_range = request.args.get('range')

    conn = get_db_connection()
    cursor = conn.cursor()
    
    query = '''
        SELECT name, price_min, price_max, link
        FROM items
        WHERE room_type = ? AND cost_range = ?
    '''
    cursor.execute(query, (room_type, cost_range))
    items = cursor.fetchall()
    conn.close()
    
    if not items:
        return jsonify([]), 404

    items_list = [dict(item) for item in items]
    return jsonify(items_list)


def analyze_room_with_gemini(image_path):
    """
    Use Gemini Vision to analyze the empty room and generate a detailed description.
    This description will be used to maintain room characteristics in the generated image.
    """
    try:
        # Load the image
        img = Image.open(image_path)
        
        # Initialize Gemini Vision model - use gemini-2.0-flash (latest)
        model = genai.GenerativeModel('gemini-2.0-flash')
        
        # Create a concise prompt for room analysis
        analysis_prompt = """Analyze this empty room image. Describe in ONE short paragraph (max 50 words):
- Wall color and floor type
- Window placement and lighting
- Room shape and style

Be concise and specific. Example: "Rectangular room with cream walls, light oak hardwood floor, two large windows on left wall, bright natural lighting, modern minimalist style."
"""
        
        # Generate the analysis
        response = model.generate_content([analysis_prompt, img])
        
        return response.text
        
    except Exception as e:
        print(f"Gemini analysis error: {e}")
        # Fallback description if Gemini fails
        return "spacious room with neutral walls, wooden floor, large windows, natural lighting"


def get_furniture_items_for_prompt(room_type, cost_range):
    """
    Get furniture items from database to include in the generation prompt.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    
    query = '''
        SELECT name FROM items
        WHERE room_type = ? AND cost_range = ?
        LIMIT 10
    '''
    cursor.execute(query, (room_type, cost_range))
    items = cursor.fetchall()
    conn.close()
    
    if items:
        return [item['name'] for item in items]
    return []


def generate_with_huggingface(prompt, room_type="room"):
    """
    Generate an image using Hugging Face Inference API.
    FREE - just needs HF token (no credit card required)!
    Uses Stable Diffusion XL for high quality interior design images.
    
    Args:
        prompt: Description of the room to generate
        room_type: Type of room for context
    """
    try:
        api_token = HF_API_TOKEN
        
        if not api_token:
            print("Hugging Face: No API token found")
            return None
        
        # Use the new Hugging Face router endpoint (api-inference is deprecated)
        api_url = "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0"
        
        headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json"
        }
        
        # Build optimized prompt for interior design
        full_prompt = f"photorealistic interior design photograph of a beautifully furnished {room_type}, {prompt}, professional interior photography, natural lighting, high quality, 4k, detailed textures, architectural digest style"
        
        payload = {
            "inputs": full_prompt,
            "parameters": {
                "negative_prompt": "cartoon, anime, sketch, drawing, blurry, low quality, distorted, watermark, text, people, person",
                "num_inference_steps": 30,
                "guidance_scale": 7.5
            }
        }
        
        print(f"Hugging Face: Generating with SDXL...")
        print(f"Hugging Face: Prompt: {full_prompt[:100]}...")
        
        response = requests.post(api_url, json=payload, headers=headers, timeout=120)
        
        if response.status_code == 200:
            # Response is raw image bytes
            if len(response.content) > 1000:
                print("Hugging Face: Image generated successfully!")
                return response.content
            else:
                print(f"Hugging Face: Response too small ({len(response.content)} bytes)")
        elif response.status_code == 503:
            # Model is loading, wait and retry
            print("Hugging Face: Model is loading, waiting...")
            import time
            time.sleep(20)
            response = requests.post(api_url, json=payload, headers=headers, timeout=120)
            if response.status_code == 200 and len(response.content) > 1000:
                print("Hugging Face: Image generated successfully!")
                return response.content
        else:
            print(f"Hugging Face error: {response.status_code} - {response.text[:200]}")
        
        return None
        
    except Exception as e:
        print(f"Hugging Face error: {e}")
        return None


def generate_with_gemini_imagen(image_path, prompt):
    """
    Generate an image using Google's Gemini with Imagen 3.
    Uses the new google.genai API for image generation.
    
    Args:
        image_path: Path to the source image (empty room)
        prompt: Description of how to transform the image
    """
    try:
        from google import genai as google_genai
        from google.genai import types
        
        # Initialize with API key
        client = google_genai.Client(api_key=GEMINI_API_KEY)
        
        # Create a detailed prompt for interior design
        generation_prompt = f"""photorealistic interior design photograph of a beautifully furnished room, {prompt}, 
professional interior photography, natural lighting, high quality, 4k, architectural digest style"""

        print(f"Gemini Imagen prompt: {generation_prompt[:200]}...")
        
        # Generate image using Imagen 3
        response = client.models.generate_images(
            model='imagen-3.0-generate-002',
            prompt=generation_prompt,
            config=types.GenerateImagesConfig(
                number_of_images=1,
                aspect_ratio="16:9",
                safety_filter_level="BLOCK_MEDIUM_AND_ABOVE"
            )
        )
        
        # Extract the image
        if response.generated_images and len(response.generated_images) > 0:
            image_data = response.generated_images[0].image.image_bytes
            print("Gemini Imagen: Successfully generated image!")
            return image_data
        
        print("Gemini Imagen: No image in response")
        return None
        
    except Exception as e:
        print(f"Gemini Imagen error: {e}")
        return None


def generate_with_prodia_img2img(image_path, prompt, denoising_strength=0.6):
    """
    Generate an image using Prodia's image-to-image API.
    This preserves the room structure while adding furniture based on the prompt.
    
    Args:
        image_path: Path to the source image (empty room)
        prompt: Description of how to transform the image
        denoising_strength: How much to change (0.0 = no change, 1.0 = complete change)
                           0.5-0.7 is good for adding furniture while keeping room structure
    """
    import time
    import random
    
    api_key = os.getenv('PRODIA_API_KEY', '')
    
    if not api_key or api_key == 'your-prodia-api-key-here':
        print("No Prodia API key found, falling back to Pollinations...")
        return None
    
    try:
        # Read and encode the image as base64
        with open(image_path, 'rb') as img_file:
            image_data = base64.b64encode(img_file.read()).decode('utf-8')
        
        # Prodia img2img endpoint
        url = "https://api.prodia.com/v1/sd/transform"
        
        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "X-Prodia-Key": api_key
        }
        
        payload = {
            "imageData": image_data,
            "prompt": prompt,
            "model": "deliberate_v2.safetensors [10ec4b29]",
            "negative_prompt": "blurry, bad quality, distorted, ugly, deformed walls, broken furniture",
            "steps": 30,
            "cfg_scale": 7,
            "seed": random.randint(1, 1000000),
            "sampler": "DPM++ 2M Karras",
            "denoising_strength": denoising_strength
        }
        
        print(f"Prodia img2img: Sending request with denoising_strength={denoising_strength}")
        
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        
        if response.status_code == 200:
            job = response.json()
            job_id = job.get('job')
            print(f"Prodia job created: {job_id}")
            
            # Poll for result
            for i in range(60):  # Wait up to 2 minutes
                time.sleep(2)
                status_response = requests.get(
                    f"https://api.prodia.com/v1/job/{job_id}",
                    headers={"X-Prodia-Key": api_key}
                )
                status = status_response.json()
                job_status = status.get('status')
                
                if job_status == 'succeeded':
                    image_url = status.get('imageUrl')
                    print(f"Prodia succeeded! Downloading from: {image_url}")
                    image_response = requests.get(image_url)
                    if image_response.status_code == 200:
                        return image_response.content
                elif job_status == 'failed':
                    print(f"Prodia job failed: {status}")
                    return None
                else:
                    if i % 5 == 0:
                        print(f"Prodia status: {job_status}...")
        else:
            print(f"Prodia API error: {response.status_code} - {response.text}")
            return None
            
    except Exception as e:
        print(f"Prodia img2img error: {e}")
        return None
    
    return None


def generate_with_pollinations(prompt, width=1024, height=1024, seed=None):
    """
    Generate an image using Pollinations AI (fallback for text-to-image).
    """
    import time
    import random
    max_retries = 3
    
    for attempt in range(max_retries):
        try:
            encoded_prompt = urllib.parse.quote(prompt, safe='')
            random_seed = seed if seed else random.randint(1, 100000)
            
            url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?width={width}&height={height}&seed={random_seed}&nologo=true"
            
            print(f"Pollinations (attempt {attempt + 1})")
            
            response = requests.get(url, timeout=120, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            })
            
            if response.status_code == 200 and len(response.content) > 1000:
                print("Pollinations: Image generated successfully!")
                return response.content
            else:
                print(f"Pollinations error {response.status_code}, retrying...")
                time.sleep(3)
                continue
                
        except Exception as e:
            print(f"Pollinations error: {e}")
            time.sleep(3)
            continue
    
    # Try with different parameters if all attempts failed
    print("Trying Pollinations with simpler prompt...")
    try:
        simple_prompt = prompt[:100] if len(prompt) > 100 else prompt
        encoded_prompt = urllib.parse.quote(simple_prompt, safe='')
        url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?width=512&height=512&nologo=true"
        
        response = requests.get(url, timeout=180, headers={
            'User-Agent': 'Mozilla/5.0'
        })
        
        if response.status_code == 200 and len(response.content) > 1000:
            print("Pollinations: Generated with simplified prompt!")
            return response.content
    except Exception as e:
        print(f"Pollinations simplified also failed: {e}")
    
    return None


def build_generation_prompt(room_description, room_type, cost_range, user_preferences, furniture_items):
    """
    Build a comprehensive prompt for image generation that preserves room characteristics
    while adding furniture based on user preferences.
    """
    # Map cost range to style descriptors
    style_mapping = {
        'Low': 'simple elegant',
        'Medium': 'stylish modern',
        'High': 'luxury premium'
    }
    
    style_descriptor = style_mapping.get(cost_range, 'stylish')
    
    # Build furniture list string (max 3 items to keep prompt short)
    furniture_str = ", ".join(furniture_items[:3]) if furniture_items else "sofa, table, decor"
    
    # Create a SHORT prompt - Pollinations works better with concise prompts
    user_style = user_preferences.strip()[:30] if user_preferences else "modern cozy"
    
    # Simple, effective prompt
    prompt = f"beautiful {room_type} with {furniture_str}, {style_descriptor} {user_style}, interior design photo, 4k"
    
    print(f"Final prompt ({len(prompt)} chars): {prompt}")
    
    return prompt


@app.route('/analyze-room', methods=['POST'])
def analyze_room():
    """
    Endpoint to analyze an uploaded room image using Gemini Vision.
    Returns the room description.
    """
    if 'image' not in request.files:
        return jsonify({'error': 'No image uploaded'}), 400
    
    uploaded_file = request.files['image']
    
    if uploaded_file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    # Save the uploaded image
    image_path = os.path.join(app.config['UPLOAD_FOLDER'], uploaded_file.filename)
    uploaded_file.save(image_path)
    
    # Analyze with Gemini
    room_description = analyze_room_with_gemini(image_path)
    
    return jsonify({
        'success': True,
        'description': room_description,
        'image_path': image_path
    })


@app.route('/generate', methods=['POST'])
def generate():
    """
    Main endpoint for generating furnished room images.
    1. Analyzes the uploaded empty room with Gemini Vision
    2. Builds a comprehensive prompt preserving room characteristics
    3. Generates the furnished room using Pollinations
    """
    # Get form data
    room_type = request.form.get('room_type', 'Living Room')
    cost_range = request.form.get('cost_range', 'Medium')
    user_preferences = request.form.get('prompt', '')
    
    # Check for uploaded image
    if 'image' not in request.files:
        return jsonify({'error': 'No image uploaded'}), 400
    
    uploaded_file = request.files['image']
    
    if uploaded_file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # Save the uploaded image
    image_path = os.path.join(app.config['UPLOAD_FOLDER'], uploaded_file.filename)
    uploaded_file.save(image_path)

    try:
        # Step 1: Get furniture items from database
        furniture_items = get_furniture_items_for_prompt(room_type, cost_range)
        print(f"Furniture items: {furniture_items}")
        
        # Step 2: Build the generation prompt
        generation_prompt = build_generation_prompt(
            "",  # Skip room analysis, Gemini Imagen will see the image directly
            room_type,
            cost_range,
            user_preferences,
            furniture_items
        )
        print(f"Generation prompt: {generation_prompt}")
        
        generated_image = None
        
        # Step 3: Generate with Hugging Face (SDXL - FREE, no credit card needed!)
        print("Generating image with Hugging Face (SDXL)...")
        try:
            generated_image = generate_with_huggingface(generation_prompt, room_type)
        except Exception as e:
            print(f"Hugging Face error: {e}")
        
        # Step 4: Fallback to Gemini if Hugging Face fails
        if not generated_image:
            print("Hugging Face failed, trying Gemini Imagen...")
            try:
                generated_image = generate_with_gemini_imagen(image_path, generation_prompt)
            except Exception as e:
                print(f"Gemini Imagen error: {e}")
        
        if not generated_image:
            return jsonify({
                'error': 'Image generation failed. Please try again in a few minutes. The free service may be busy.'
            }), 503
        
        # Step 5: Save the generated image
        output_filename = f'generated_{os.path.splitext(uploaded_file.filename)[0]}.png'
        generated_image_path = os.path.join(app.config['GENERATED_FOLDER'], output_filename)
        
        with open(generated_image_path, 'wb') as f:
            f.write(generated_image)
        
        print(f"Image saved to: {generated_image_path}")
        
        # Return the generated image
        return send_file(
            BytesIO(generated_image),
            mimetype='image/png',
            as_attachment=False
        )
        
    except Exception as e:
        print(f"Generation error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/generate-preview', methods=['POST'])
def generate_preview():
    """
    Endpoint that returns both the room analysis and generated image URL.
    Useful for showing the user what was detected before generation.
    """
    room_type = request.form.get('room_type', 'Living Room')
    cost_range = request.form.get('cost_range', 'Medium')
    user_preferences = request.form.get('prompt', '')
    
    if 'image' not in request.files:
        return jsonify({'error': 'No image uploaded'}), 400
    
    uploaded_file = request.files['image']
    
    if uploaded_file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    image_path = os.path.join(app.config['UPLOAD_FOLDER'], uploaded_file.filename)
    uploaded_file.save(image_path)

    try:
        # Analyze the room
        room_description = analyze_room_with_gemini(image_path)
        
        # Get furniture items
        furniture_items = get_furniture_items_for_prompt(room_type, cost_range)
        
        # Build prompt
        generation_prompt = build_generation_prompt(
            room_description,
            room_type,
            cost_range,
            user_preferences,
            furniture_items
        )
        
        # Create Pollinations URL (direct link)
        encoded_prompt = urllib.parse.quote(generation_prompt)
        pollinations_url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?width=1024&height=1024&nologo=true"
        
        return jsonify({
            'success': True,
            'room_analysis': room_description,
            'furniture_items': furniture_items,
            'generation_prompt': generation_prompt,
            'image_url': pollinations_url
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/')
def index():
    return render_template('index.html')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
