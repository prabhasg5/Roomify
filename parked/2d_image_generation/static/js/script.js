// Image preview functionality
document.getElementById('imageUpload').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const preview = document.getElementById('imagePreview');
            preview.innerHTML = `<img src="${e.target.result}" alt="Room Preview">`;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
});

// Download generated image
function downloadImage() {
    const img = document.getElementById('resultImage');
    if (img.src) {
        const link = document.createElement('a');
        link.href = img.src;
        link.download = 'furnished_room.png';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

// Show/hide loading state
function setLoading(isLoading) {
    const btn = document.getElementById('generateBtn');
    const btnText = document.getElementById('btnText');
    const btnLoader = document.getElementById('btnLoader');
    
    if (isLoading) {
        btn.disabled = true;
        btnText.textContent = 'Analyzing & Generating...';
        btnLoader.style.display = 'inline-block';
    } else {
        btn.disabled = false;
        btnText.textContent = '🪄 Generate Furnished Room';
        btnLoader.style.display = 'none';
    }
}

// Show error message
function showError(message) {
    const errorContainer = document.getElementById('errorContainer');
    const errorMessage = document.getElementById('errorMessage');
    errorMessage.textContent = message;
    errorContainer.style.display = 'block';
    setTimeout(() => {
        errorContainer.style.display = 'none';
    }, 5000);
}

async function handleFormActions() {
    const imageInput = document.getElementById('imageUpload').files[0];
    const prompt = document.getElementById('promptInput').value;
    const roomType = document.getElementById('room-type').value;
    const costRange = document.getElementById('cost-range').value;

    // Validation
    if (!imageInput) {
        showError('Please upload an empty room image.');
        return;
    }

    if (!roomType || !costRange) {
        showError('Please select both room type and budget range.');
        return;
    }

    setLoading(true);
    
    // Hide previous results
    document.getElementById('resultContainer').style.display = 'none';
    document.getElementById('analysisSection').style.display = 'none';
    document.getElementById('errorContainer').style.display = 'none';

    try {
        // Fetch items based on room type and cost range
        const responseItems = await fetch(`/items?room=${encodeURIComponent(roomType)}&range=${encodeURIComponent(costRange)}`);
        
        if (responseItems.ok) {
            const items = await responseItems.json();
            const itemsBody = document.getElementById('items-body');
            itemsBody.innerHTML = '';

            if (items.length === 0) {
                itemsBody.innerHTML = '<tr><td colspan="3">No items found for this selection.</td></tr>';
            } else {
                items.forEach(item => {
                    const row = document.createElement('tr');
                    const itemNameCell = document.createElement('td');
                    const priceRangeCell = document.createElement('td');
                    const linkCell = document.createElement('td');

                    itemNameCell.textContent = item.name;
                    priceRangeCell.textContent = `₹${item.price_min.toLocaleString()} - ₹${item.price_max.toLocaleString()}`;

                    const link = document.createElement('a');
                    link.href = item.link;
                    link.textContent = 'View Item';
                    link.target = '_blank';
                    linkCell.appendChild(link);

                    row.appendChild(itemNameCell);
                    row.appendChild(priceRangeCell);
                    row.appendChild(linkCell);
                    itemsBody.appendChild(row);
                });
            }
            document.getElementById('items-table').style.display = 'table';
        }

        // Generate furnished room image
        const formData = new FormData();
        formData.append('image', imageInput);
        formData.append('room_type', roomType);
        formData.append('cost_range', costRange);
        formData.append('prompt', prompt);

        console.log('Sending generation request...');
        
        const responseImage = await fetch('/generate', {
            method: 'POST',
            body: formData
        });

        if (responseImage.ok) {
            const contentType = responseImage.headers.get('content-type');
            
            if (contentType && contentType.includes('image')) {
                // Successfully received an image
                const blob = await responseImage.blob();
                const imageUrl = URL.createObjectURL(blob);
                document.getElementById('resultImage').src = imageUrl;
                document.getElementById('resultContainer').style.display = 'block';
                
                // Scroll to result
                document.getElementById('resultContainer').scrollIntoView({ behavior: 'smooth' });
            } else {
                // Response might be JSON with error
                const result = await responseImage.json();
                if (result.room_analysis) {
                    document.getElementById('roomAnalysis').textContent = result.room_analysis;
                    document.getElementById('analysisSection').style.display = 'block';
                }
                if (result.error) {
                    showError(result.error);
                }
            }
        } else {
            const errorData = await responseImage.json();
            showError(errorData.error || 'Image generation failed. Please try again.');
        }

    } catch (error) {
        console.error('Error:', error);
        showError('An error occurred. Please check the console for more details.');
    } finally {
        setLoading(false);
    }
}

