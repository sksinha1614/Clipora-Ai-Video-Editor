#!/usr/bin/env python3
"""
Comprehensive Backend API Testing for Video Roughcut Generator
Tests all API endpoints: upload, process, and status
"""

import requests
import json
import time
import os
import tempfile
from io import BytesIO

# Get base URL from environment
BASE_URL = "https://deploy-buddy-32.preview.emergentagent.com/api"

def create_mock_video_file():
    """Create a mock video file for testing"""
    # Create a simple mock video file (just bytes that look like a video)
    mock_video_content = b'\x00\x00\x00\x20ftypmp41\x00\x00\x00\x00mp41isom\x00\x00\x00\x08free' + b'\x00' * 1000
    
    # Create temporary file
    temp_file = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    temp_file.write(mock_video_content)
    temp_file.close()
    
    return temp_file.name

def test_upload_endpoint():
    """Test POST /api/upload endpoint"""
    print("\n=== Testing Upload Endpoint (POST /api/upload) ===")
    
    # Test 1: Successful upload
    print("\n1. Testing successful video upload...")
    try:
        mock_video_path = create_mock_video_file()
        
        with open(mock_video_path, 'rb') as video_file:
            files = {'video': ('test_video.mp4', video_file, 'video/mp4')}
            response = requests.post(f"{BASE_URL}/upload", files=files, timeout=30)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 200:
            data = response.json()
            if 'videoId' in data and 'filename' in data and 'size' in data:
                print("✅ Upload successful - contains required fields")
                video_id = data['videoId']
                os.unlink(mock_video_path)  # Clean up temp file
                return video_id
            else:
                print("❌ Upload response missing required fields")
                return None
        else:
            print(f"❌ Upload failed with status {response.status_code}")
            return None
            
    except Exception as e:
        print(f"❌ Upload test failed with error: {str(e)}")
        return None
    
    # Test 2: Missing file error
    print("\n2. Testing missing file error...")
    try:
        response = requests.post(f"{BASE_URL}/upload", files={}, timeout=30)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 400:
            print("✅ Correctly handles missing file")
        else:
            print("❌ Should return 400 for missing file")
    except Exception as e:
        print(f"❌ Missing file test failed: {str(e)}")
    
    # Test 3: Invalid file type
    print("\n3. Testing invalid file type...")
    try:
        # Create a text file instead of video
        temp_file = tempfile.NamedTemporaryFile(suffix='.txt', delete=False)
        temp_file.write(b'This is not a video file')
        temp_file.close()
        
        with open(temp_file.name, 'rb') as text_file:
            files = {'video': ('test.txt', text_file, 'text/plain')}
            response = requests.post(f"{BASE_URL}/upload", files=files, timeout=30)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 400:
            print("✅ Correctly rejects invalid file type")
        else:
            print("❌ Should return 400 for invalid file type")
            
        os.unlink(temp_file.name)  # Clean up
        
    except Exception as e:
        print(f"❌ Invalid file type test failed: {str(e)}")
    
    return None

def test_process_endpoint(video_id=None):
    """Test POST /api/process endpoint"""
    print("\n=== Testing Process Endpoint (POST /api/process) ===")
    
    # Test 1: Valid videoId processing
    if video_id:
        print(f"\n1. Testing processing with valid videoId: {video_id}")
        try:
            payload = {"videoId": video_id}
            response = requests.post(f"{BASE_URL}/process", 
                                   json=payload, 
                                   headers={'Content-Type': 'application/json'},
                                   timeout=30)
            
            print(f"Status Code: {response.status_code}")
            print(f"Response: {response.text}")
            
            if response.status_code == 200:
                data = response.json()
                if data.get('success') and 'videoId' in data:
                    print("✅ Processing started successfully")
                    return True
                else:
                    print("❌ Processing response missing required fields")
            else:
                print(f"❌ Processing failed with status {response.status_code}")
                
        except Exception as e:
            print(f"❌ Processing test failed: {str(e)}")
    
    # Test 2: Missing videoId
    print("\n2. Testing missing videoId error...")
    try:
        response = requests.post(f"{BASE_URL}/process", 
                               json={}, 
                               headers={'Content-Type': 'application/json'},
                               timeout=30)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 400:
            print("✅ Correctly handles missing videoId")
        else:
            print("❌ Should return 400 for missing videoId")
    except Exception as e:
        print(f"❌ Missing videoId test failed: {str(e)}")
    
    # Test 3: Invalid videoId
    print("\n3. Testing invalid videoId...")
    try:
        payload = {"videoId": "invalid-video-id-12345"}
        response = requests.post(f"{BASE_URL}/process", 
                               json=payload, 
                               headers={'Content-Type': 'application/json'},
                               timeout=30)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 404:
            print("✅ Correctly handles invalid videoId")
        else:
            print("❌ Should return 404 for invalid videoId")
    except Exception as e:
        print(f"❌ Invalid videoId test failed: {str(e)}")
    
    return False

def test_status_endpoint(video_id=None):
    """Test GET /api/status/:videoId endpoint"""
    print("\n=== Testing Status Endpoint (GET /api/status/:videoId) ===")
    
    if video_id:
        print(f"\n1. Testing status for valid videoId: {video_id}")
        try:
            response = requests.get(f"{BASE_URL}/status/{video_id}", timeout=30)
            
            print(f"Status Code: {response.status_code}")
            print(f"Response: {response.text}")
            
            if response.status_code == 200:
                data = response.json()
                required_fields = ['videoId', 'filename', 'status', 'uploadedAt']
                if all(field in data for field in required_fields):
                    print("✅ Status response contains required fields")
                    print(f"Current status: {data.get('status')}")
                    return data
                else:
                    print("❌ Status response missing required fields")
            else:
                print(f"❌ Status check failed with status {response.status_code}")
                
        except Exception as e:
            print(f"❌ Status test failed: {str(e)}")
    
    # Test 2: Invalid videoId
    print("\n2. Testing status for invalid videoId...")
    try:
        response = requests.get(f"{BASE_URL}/status/invalid-video-id", timeout=30)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 404:
            print("✅ Correctly handles invalid videoId")
        else:
            print("❌ Should return 404 for invalid videoId")
    except Exception as e:
        print(f"❌ Invalid videoId status test failed: {str(e)}")
    
    # Test 3: Missing videoId
    print("\n3. Testing status with missing videoId...")
    try:
        response = requests.get(f"{BASE_URL}/status/", timeout=30)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 400 or response.status_code == 404:
            print("✅ Correctly handles missing videoId")
        else:
            print("❌ Should return 400 or 404 for missing videoId")
    except Exception as e:
        print(f"❌ Missing videoId status test failed: {str(e)}")
    
    return None

def test_complete_workflow():
    """Test the complete workflow: upload -> process -> poll status"""
    print("\n=== Testing Complete Workflow ===")
    
    # Step 1: Upload video
    video_id = test_upload_endpoint()
    if not video_id:
        print("❌ Workflow failed: Could not upload video")
        return False
    
    # Step 2: Start processing
    processing_started = test_process_endpoint(video_id)
    if not processing_started:
        print("❌ Workflow failed: Could not start processing")
        return False
    
    # Step 3: Poll status until completed
    print(f"\n=== Polling Status for Video {video_id} ===")
    max_polls = 10
    poll_interval = 1  # seconds
    
    for i in range(max_polls):
        print(f"\nPoll {i+1}/{max_polls}:")
        status_data = test_status_endpoint(video_id)
        
        if status_data:
            current_status = status_data.get('status')
            print(f"Current status: {current_status}")
            
            if current_status == 'completed':
                print("✅ Processing completed!")
                
                # Verify results
                if 'results' in status_data and status_data['results']:
                    results = status_data['results']
                    if 'roughcuts' in results and len(results['roughcuts']) == 3:
                        print("✅ Results contain expected 3 roughcuts")
                        print(f"Roughcuts: {results['roughcuts']}")
                        return True
                    else:
                        print("❌ Results missing expected roughcuts")
                else:
                    print("❌ Completed status missing results")
                break
            elif current_status == 'failed':
                print("❌ Processing failed")
                break
            elif current_status == 'processing':
                print("⏳ Still processing, waiting...")
                time.sleep(poll_interval)
            else:
                print(f"⏳ Status: {current_status}, waiting...")
                time.sleep(poll_interval)
        else:
            print("❌ Could not get status")
            break
    
    print("❌ Workflow incomplete or failed")
    return False

def main():
    """Run all backend API tests"""
    print("🚀 Starting Comprehensive Backend API Tests")
    print(f"Base URL: {BASE_URL}")
    
    try:
        # Test individual endpoints
        print("\n" + "="*60)
        print("INDIVIDUAL ENDPOINT TESTS")
        print("="*60)
        
        test_upload_endpoint()
        test_process_endpoint()
        test_status_endpoint()
        
        # Test complete workflow
        print("\n" + "="*60)
        print("COMPLETE WORKFLOW TEST")
        print("="*60)
        
        workflow_success = test_complete_workflow()
        
        # Summary
        print("\n" + "="*60)
        print("TEST SUMMARY")
        print("="*60)
        
        if workflow_success:
            print("✅ All tests passed! Backend API is working correctly.")
        else:
            print("❌ Some tests failed. Check the output above for details.")
            
    except Exception as e:
        print(f"❌ Test suite failed with error: {str(e)}")

if __name__ == "__main__":
    main()