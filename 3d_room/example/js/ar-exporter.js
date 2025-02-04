/**
 * AR Exporter Module (Compatible with Three.js r69)
 * Saves the room design and opens AR view
 */

var ARExporter = (function() {
    
    var AR_SERVER_URL = null;
    
    function getARServerURL() {
        if (AR_SERVER_URL) return AR_SERVER_URL;
        
        var hostname = window.location.hostname;
        // Use HTTP port 8003 for local development to avoid CORS/certificate issues
        var port = '8003';
        
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '') {
            AR_SERVER_URL = 'http://localhost:' + port;
        } else {
            // For network access, use HTTPS on port 8002
            AR_SERVER_URL = 'https://' + hostname + ':8002';
        }
        return AR_SERVER_URL;
    }
    
    /**
     * Save the current design to the AR server
     */
    function saveDesignToServer(blueprint3d, onSuccess, onError) {
        var designData = blueprint3d.model.exportSerialized();
        var serverUrl = getARServerURL();
        
        console.log('Saving design to server:', serverUrl);
        
        fetch(serverUrl + '/save-design', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: designData
        })
        .then(function(response) {
            if (!response.ok) {
                throw new Error('Server error: ' + response.status);
            }
            return response.json();
        })
        .then(function(data) {
            console.log('Design saved:', data);
            if (data.success) {
                onSuccess(data.arUrl, data.designUrl);
            } else {
                onError(new Error(data.error || 'Failed to save design'));
            }
        })
        .catch(function(error) {
            console.error('Save error:', error);
            onError(error);
        });
    }
    
    /**
     * Export scene to GLB using a simpler approach
     * This creates a basic GLB with just the furniture positions
     */
    function exportFullScene(blueprint3d, onComplete, onError) {
        try {
            console.log('Starting export...');
            
            // For older Three.js, we'll save the design JSON instead
            // and let the AR server convert it or use a different approach
            var designData = blueprint3d.model.exportSerialized();
            var designObj = JSON.parse(designData);
            
            console.log('Design data:', designObj);
            console.log('Items count:', designObj.items ? designObj.items.length : 0);
            
            // Create a simple JSON blob that the AR view can use
            var blob = new Blob([designData], { type: 'application/json' });
            
            onComplete(blob);
        } catch (error) {
            console.error('Export error:', error);
            onError(error);
        }
    }
    
    /**
     * Upload the design to AR server
     */
    function uploadToARServer(blob, serverUrl, onSuccess, onError) {
        console.log('Uploading to AR server:', serverUrl);
        
        // Read the blob as text (it's JSON)
        var reader = new FileReader();
        reader.onload = function(e) {
            var designData = e.target.result;
            
            fetch(serverUrl + '/save-design', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: designData
            })
            .then(function(response) {
                if (!response.ok) {
                    throw new Error('Server responded with ' + response.status);
                }
                return response.json();
            })
            .then(function(data) {
                console.log('Upload response:', data);
                if (data.success) {
                    onSuccess(data.arUrl, data.designUrl);
                } else {
                    onError(new Error(data.error || 'Upload failed'));
                }
            })
            .catch(function(error) {
                console.error('Upload fetch error:', error);
                onError(error);
            });
        };
        reader.onerror = function() {
            onError(new Error('Failed to read design data'));
        };
        reader.readAsText(blob);
    }
    
    /**
     * Generate QR code
     */
    function generateQRCode(url, container) {
        console.log('Generating QR code for:', url);
        
        // Load QRCode library dynamically
        if (typeof QRCode === 'undefined') {
            var script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js';
            script.onload = function() {
                createQR(url, container);
            };
            script.onerror = function() {
                container.innerHTML = '<p style="color: red;">Could not load QR code library</p>';
            };
            document.head.appendChild(script);
        } else {
            createQR(url, container);
        }
    }
    
    function createQR(url, container) {
        container.innerHTML = '';
        var canvas = document.createElement('canvas');
        container.appendChild(canvas);
        
        QRCode.toCanvas(canvas, url, {
            width: 200,
            margin: 2
        }, function(error) {
            if (error) {
                console.error('QR error:', error);
                container.innerHTML = '<p style="color: red;">QR Code generation failed</p>';
            }
        });
    }
    
    /**
     * Download the design as JSON
     */
    function downloadGLB(blob, filename) {
        filename = filename || 'room-design.json';
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    /**
     * Open AR view directly
     */
    function openARView() {
        var arUrl = getARServerURL() + '/ar-view.html';
        window.open(arUrl, '_blank');
    }
    
    // Public API
    return {
        exportFullScene: exportFullScene,
        uploadToARServer: uploadToARServer,
        generateQRCode: generateQRCode,
        downloadGLB: downloadGLB,
        openARView: openARView,
        getARServerURL: getARServerURL
    };
    
})();

console.log('ARExporter loaded successfully');
