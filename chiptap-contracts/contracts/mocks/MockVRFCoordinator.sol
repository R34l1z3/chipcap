// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/**
 * @title MockVRFCoordinator
 * @notice Simulates Chainlink VRF v2.5 for local testing.
 *         Implements the same `requestRandomWords(VRFV2PlusClient.RandomWordsRequest)`
 *         signature as the real coordinator so that selectors match.
 *         Test scripts can fulfill requests manually via `fulfillRandomWords`.
 */
contract MockVRFCoordinator {
    struct Request {
        address caller;
        uint256 subId;
        uint32 callbackGasLimit;
        uint16 requestConfirmations;
        uint32 numWords;
        bool fulfilled;
    }

    uint256 public nextRequestId = 1;
    mapping(uint256 => Request) public requests;

    event RandomWordsRequested(uint256 indexed requestId, address indexed caller);
    event RandomWordsFulfilled(uint256 indexed requestId, uint256[] randomWords);

    /**
     * @notice Real coordinator method called by VRFConsumerBaseV2Plus.
     * @dev Selector matches IVRFCoordinatorV2Plus.requestRandomWords so the
     *      consumer can call us via the s_vrfCoordinator interface.
     */
    function requestRandomWords(
        VRFV2PlusClient.RandomWordsRequest calldata req
    ) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        requests[requestId] = Request({
            caller: msg.sender,
            subId: req.subId,
            callbackGasLimit: req.callbackGasLimit,
            requestConfirmations: req.requestConfirmations,
            numWords: req.numWords,
            fulfilled: false
        });

        emit RandomWordsRequested(requestId, msg.sender);
        return requestId;
    }

    /**
     * @notice Test helper: fulfill a VRF request with specific random words.
     * @param requestId The request to fulfill.
     * @param randomWords Array of random numbers.
     */
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        Request storage req = requests[requestId];
        require(req.caller != address(0), "Request not found");
        require(!req.fulfilled, "Already fulfilled");

        req.fulfilled = true;

        // Call the consumer's rawFulfillRandomWords
        (bool success, bytes memory reason) = req.caller.call(
            abi.encodeWithSignature(
                "rawFulfillRandomWords(uint256,uint256[])",
                requestId,
                randomWords
            )
        );
        require(success, string(abi.encodePacked("Fulfillment failed: ", reason)));

        emit RandomWordsFulfilled(requestId, randomWords);
    }

    /**
     * @notice Fulfill with a deterministic "random" number based on requestId.
     */
    function fulfillRandomWordsSimple(uint256 requestId) external {
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256(abi.encodePacked(requestId, block.timestamp, block.prevrandao)));

        Request storage req = requests[requestId];
        require(req.caller != address(0), "Request not found");
        require(!req.fulfilled, "Already fulfilled");
        req.fulfilled = true;

        (bool success, ) = req.caller.call(
            abi.encodeWithSignature(
                "rawFulfillRandomWords(uint256,uint256[])",
                requestId,
                words
            )
        );
        require(success, "Fulfillment failed");

        emit RandomWordsFulfilled(requestId, words);
    }
}
